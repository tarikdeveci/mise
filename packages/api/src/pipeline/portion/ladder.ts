import type { CanonicalFood } from '../../domain/food.js';
import type { PortionEstimate, PortionMethod } from '../../domain/log.js';
import {
  canonicalUnit, detectSize, isMassUnit, isVolumeUnit,
  parseQuantity, toGrams, toMillilitres,
} from '../normalize.js';
import type { PortionContext, PortionStrategy } from './types.js';

/**
 * Interval half-widths, as a fraction of the likely value.
 *
 * These are the ladder's whole point made numeric: the further down you fall,
 * the less you know. Each figure is sourced rather than chosen — see README for
 * the studies behind the reference-object and photo-only numbers.
 */
const SPREAD = {
  /** The user weighed it. Only scale rounding is left. */
  statedMass: 0.02,
  /** Stated volume through the food's own density. */
  statedVolume: 0.05,
  /** A label serving. Exact, but people eat partial packages. */
  barcodeLabel: 0.08,
  /** This person confirmed this portion before. Their "usual" still drifts. */
  userMemory: 0.1,
  /**
   * A photo with a scale reference in frame. Published work puts a plain
   * credit card at 34% -> 18% calorie error, close to LiDAR fusion at no
   * hardware cost.
   */
  referenceScaled: 0.18,
  /** A photo with no reference and no stated amount. The hardest case. */
  photoFloor: 0.4,
  /** Hedges: "a handful", "biraz". Unknown within a factor. */
  vague: 0.5,
  /** Nothing stated at all, and no photo either. */
  bareDefault: 0.3,
} as const;

const DEFAULT_DENSITY_G_PER_ML = 1.0;

/**
 * More than this of one food, in one sitting, is a parsing accident.
 *
 * Real case: a photo of stuffed pasta shells produced "17 pieces". Pasta has no
 * `piece` measure, so the count fell through to the default (a 140 g cup) and
 * the ladder cheerfully returned 2.4 kg of pasta and 3,478 kcal. A plate of
 * food is not two and a half kilos, and the arithmetic was internally
 * consistent the whole way — which is exactly why it needs a bound rather than
 * better reasoning.
 */
const IMPLAUSIBLE_ITEM_GRAMS = 1200;

function interval(
  grams: number,
  spread: number,
  basis: PortionEstimate['basis'],
  method: PortionMethod,
  assumption: string,
  fromVision = false,
): PortionEstimate {
  const clamped = Math.max(0.1, grams);
  return {
    gramsLikely: Number(clamped.toFixed(1)),
    gramsMin: Number((clamped * (1 - Math.min(spread, 0.95))).toFixed(1)),
    gramsMax: Number((clamped * (1 + spread)).toFixed(1)),
    basis,
    assumption,
    fromVision,
    method,
  };
}

/* ─────────────────────── shared reading of the words ─────────────────────── */

interface Reading {
  quantity: number | undefined;
  vague: boolean;
  unit: string | undefined;
}

function read(ctx: PortionContext): Reading {
  const parsed = parseQuantity(ctx.item.phrase);
  const unit =
    canonicalUnit(ctx.item.unit) ?? canonicalUnit(unitTokenIn(ctx, ctx.item.phrase));
  return {
    quantity: ctx.item.quantity ?? parsed.value,
    vague: ctx.item.quantity === undefined && parsed.vague,
    unit,
  };
}

/**
 * Finds a unit token in the raw phrase when the extractor did not supply one.
 * Only units the food actually defines count, so "1 bardak çay" matches tea's
 * own glass row rather than a generic 240 ml cup.
 */
function unitTokenIn(ctx: PortionContext, phrase: string): string | undefined {
  for (const raw of phrase.toLowerCase().split(/[\s,]+/)) {
    const unit = canonicalUnit(raw);
    if (!unit) continue;
    if (isMassUnit(unit) || isVolumeUnit(unit) || ctx.db.measureFor(ctx.food, unit)) return raw;
  }
  return undefined;
}

/** Grams implied by the user's words and the food's measure table, if any. */
function gramsFromWords(
  ctx: PortionContext,
  reading: Reading,
): { grams: number; assumption: string; ownSpread: number } | null {
  const { food, item } = ctx;

  if (reading.unit) {
    const measure = ctx.db.measureFor(food, reading.unit);
    if (measure) {
      const n = reading.quantity ?? 1;
      return {
        grams: n * measure.grams,
        assumption: `${n} x ${measure.unit} = ${measure.grams} g each`,
        ownSpread: measure.spread,
      };
    }
  }

  const size = detectSize(item.phrase);
  if (size) {
    const measure = ctx.db.measureFor(food, size);
    if (measure) {
      const n = reading.quantity ?? 1;
      return {
        grams: n * measure.grams,
        assumption: `${size} = ${measure.grams} g`,
        ownSpread: measure.spread,
      };
    }
  }

  const fallback = ctx.db.defaultMeasure(food);
  if (reading.quantity !== undefined && fallback) {
    // "17 pieces" against a food measured in cups is not 17 cups. When the user
    // named a unit and this food does not define it, the count describes
    // something we cannot convert, so the count is dropped rather than applied
    // to an unrelated measure.
    const unitStatedButUnknown = reading.unit !== undefined && !ctx.db.measureFor(food, reading.unit);
    if (unitStatedButUnknown) return null;

    const grams = reading.quantity * fallback.grams;
    if (grams > IMPLAUSIBLE_ITEM_GRAMS) return null;

    return {
      grams,
      assumption: `${reading.quantity} x ${fallback.unit} = ${fallback.grams} g each`,
      ownSpread: fallback.spread,
    };
  }

  return null;
}

/* ──────────────────────────── the rungs ──────────────────────────── */

/** 1. The user weighed it. Nothing to estimate. */
const statedMass: PortionStrategy = {
  method: 'stated_mass',
  estimate(ctx) {
    const { quantity, unit } = read(ctx);
    if (quantity === undefined || !isMassUnit(unit)) return null;
    return interval(
      toGrams(quantity, unit),
      SPREAD.statedMass,
      'explicit_mass',
      'stated_mass',
      `${quantity} ${unit} as stated`,
    );
  },
};

/** 2. A stated volume, through the food's own density. */
const statedVolume: PortionStrategy = {
  method: 'stated_volume',
  estimate(ctx) {
    const { quantity, unit } = read(ctx);
    if (quantity === undefined || !isVolumeUnit(unit)) return null;
    const ml = toMillilitres(quantity, unit);
    const density = ctx.food.densityGPerMl ?? DEFAULT_DENSITY_G_PER_ML;
    return interval(
      ml * density,
      SPREAD.statedVolume,
      'explicit_volume',
      'stated_volume',
      ctx.food.densityGPerMl
        ? `${ml} ml x ${density} g/ml`
        : `${ml} ml, assumed ${density} g/ml (no density on record)`,
    );
  },
};

/**
 * 3. A scanned label.
 *
 * The cheapest exact answer there is: the package states the serving mass, so
 * there is no vision, no retrieval and no estimate anywhere in the path.
 */
const barcodeLabel: PortionStrategy = {
  method: 'barcode_label',
  estimate(ctx) {
    const serving = ctx.barcode?.servingGrams;
    if (serving === undefined) return null;
    const { quantity } = read(ctx);
    const n = quantity ?? 1;
    return interval(
      n * serving,
      SPREAD.barcodeLabel,
      'household_measure',
      'barcode_label',
      `${n} x labelled serving (${serving} g) from ${ctx.barcode?.source ?? 'the package'}`,
    );
  },
};

/**
 * 4. This person already told us what their portion of this is.
 *
 * Most logging is repetition, so this rung is reached far more often than its
 * position suggests, and it costs nothing: no model call, no network, and the
 * same answer every time. It is also the only rung that gets better with use.
 */
const userMemory: PortionStrategy = {
  method: 'user_memory',
  estimate(ctx) {
    // A stated amount always wins: if they typed a number this time, they meant
    // it, and replaying an old one would silently overrule them.
    const { quantity, unit } = read(ctx);
    if (quantity !== undefined && (isMassUnit(unit) || isVolumeUnit(unit))) return null;

    const remembered = ctx.aliases.lookup(ctx.userId, ctx.item.phrase);
    if (remembered?.scope !== 'user' || remembered.grams === undefined) return null;

    const n = quantity ?? 1;
    return interval(
      n * remembered.grams,
      SPREAD.userMemory,
      'household_measure',
      'user_memory',
      `${n} x your usual (${remembered.grams} g)`,
    );
  },
};

/**
 * 5. A photo with something of known size in frame.
 *
 * A scale reference is the difference between a model guessing how big a plate
 * is and a model measuring against something it knows. It cannot narrow the
 * interval to nothing — this still routes through the model's reading — but the
 * published gap between referenced and unreferenced photos is large enough that
 * asking the user for it is worth one line of interface.
 */
const referenceScaled: PortionStrategy = {
  method: 'reference_scaled',
  estimate(ctx) {
    if (!ctx.fromImage || ctx.reference === 'none') return null;
    const reading = read(ctx);
    const words = gramsFromWords(ctx, reading);
    if (!words) return null;
    return interval(
      words.grams,
      SPREAD.referenceScaled,
      'household_measure',
      'reference_scaled',
      `${words.assumption}, scaled against the ${ctx.reference} in frame`,
      true,
    );
  },
};

/** 6. Their words against our measure table. */
const householdMeasure: PortionStrategy = {
  method: 'household_measure',
  estimate(ctx) {
    const reading = read(ctx);
    const words = gramsFromWords(ctx, reading);
    if (!words) return null;
    // A count read off pixels is not a count someone typed: photo readings were
    // measured swinging 84% run to run, so they never get the tight interval.
    const spread = ctx.fromImage ? Math.max(words.ownSpread, SPREAD.photoFloor) : words.ownSpread;
    return interval(
      words.grams,
      spread,
      'household_measure',
      'household_measure',
      words.assumption,
      ctx.fromImage,
    );
  },
};

/**
 * 7. Nothing above could answer. Assume the food's default portion and say so
 * with an interval wide enough to be honest about it.
 */
const modelEstimate: PortionStrategy = {
  method: 'model_estimate',
  estimate(ctx) {
    const { vague } = read(ctx);
    const fallback = ctx.db.defaultMeasure(ctx.food);

    if (!fallback) {
      // The loader forbids a food with no measures, but a future seed edit
      // could reintroduce one and a silent 100 g would be worse than an
      // obviously wide guess.
      return interval(100, 0.6, 'visual_default', 'model_estimate',
        'no measures on record, assumed 100 g', ctx.fromImage);
    }

    if (vague) {
      return interval(
        fallback.grams, SPREAD.vague, 'vague_quantifier', 'model_estimate',
        `unspecified amount, assumed about one ${fallback.unit} (${fallback.grams} g)`,
        ctx.fromImage,
      );
    }

    return interval(
      fallback.grams,
      ctx.fromImage ? SPREAD.photoFloor : Math.max(fallback.spread, SPREAD.bareDefault),
      ctx.fromImage ? 'visual_default' : 'household_measure',
      'model_estimate',
      `no amount given, assumed one ${fallback.unit} (${fallback.grams} g)`,
      ctx.fromImage,
    );
  },
};

/**
 * The ladder, in order. Cheapest and most exact first; each rung returns null
 * rather than guess, so the question falls through to whatever can actually
 * answer it.
 */
export const PORTION_LADDER: PortionStrategy[] = [
  statedMass,
  statedVolume,
  barcodeLabel,
  userMemory,
  referenceScaled,
  householdMeasure,
  modelEstimate,
];

export function runLadder(ctx: PortionContext): PortionEstimate {
  for (const rung of PORTION_LADDER) {
    const estimate = rung.estimate(ctx);
    if (!estimate) continue;

    // A stated mass is the user's own claim and is left alone; anything we
    // derived is bounded, because a derivation that lands at two kilos of one
    // food is a parsing accident dressed as arithmetic.
    if (estimate.method !== 'stated_mass' && estimate.gramsLikely > IMPLAUSIBLE_ITEM_GRAMS) {
      const fallback = ctx.db.defaultMeasure(ctx.food);
      const grams = fallback?.grams ?? 100;
      return interval(
        grams, SPREAD.vague, 'vague_quantifier', 'model_estimate',
        `the stated amount worked out to ${Math.round(estimate.gramsLikely)} g, which is not a ` +
        `plausible serving, so one ${fallback?.unit ?? 'portion'} was assumed instead`,
        ctx.fromImage,
      );
    }
    return estimate;
  }
  // modelEstimate never returns null, so this is unreachable; keeping the
  // exhaustive return means adding a rung can never silently break the contract.
  throw new Error(`portion ladder exhausted for ${ctx.food.id}`);
}

/** Human wording for each rung, shown in the app next to the number. */
export const METHOD_LABEL: Record<PortionMethod, string> = {
  stated_mass: 'You weighed it',
  stated_volume: 'You measured it',
  barcode_label: 'From the label',
  user_memory: 'Your usual',
  household_measure: 'From your words',
  reference_scaled: 'Scaled to the reference',
  model_estimate: 'Estimated',
};

/** Rough calorie error to expect from each rung. Shown so the number is judgeable. */
export const METHOD_ERROR: Record<PortionMethod, string> = {
  stated_mass: '±2%',
  stated_volume: '±5%',
  barcode_label: '±8%',
  user_memory: '±10%',
  household_measure: '',
  reference_scaled: '±18%',
  model_estimate: '±25–35%',
};

export type { CanonicalFood };
