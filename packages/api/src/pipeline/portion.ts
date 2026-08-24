import type { CanonicalFood } from '../domain/food.js';
import type { ExtractedItem, PortionEstimate } from '../domain/log.js';
import type { FoodDb } from '../data/foodDb.js';
import {
  canonicalUnit, detectSize, isMassUnit, isVolumeUnit,
  parseQuantity, toGrams, toMillilitres,
} from './normalize.js';

/**
 * Portion estimation.
 *
 * This is where most calorie error actually lives. Nutrition5k reports that
 * trained dietitians average ~41% error estimating portions from images, so
 * any single gram figure we print is false precision. Every branch below
 * therefore returns an INTERVAL whose width reflects how the number was
 * obtained: a kitchen scale reading is near-exact, "a handful" is not, and a
 * photo with no stated quantity is the widest of all.
 *
 * Carrying that width through to the UI is the difference between "537 kcal"
 * (confident, unfalsifiable, usually wrong) and "520 ± 90 kcal" (honest, and
 * exactly as precise as the evidence supports).
 */

/** Interval half-widths, as a fraction of the likely value. */
const SPREAD = {
  /** A stated mass. Only scale/rounding error remains. */
  explicitMass: 0.02,
  /** A stated volume. Density is a lookup, not a guess. */
  explicitVolume: 0.05,
  /** Hedges: "a handful", "biraz". Genuinely unknown within a factor. */
  vague: 0.5,
  /** A photo with nothing stated. The hardest case in the whole system. */
  visualDefault: 0.45,
} as const;

/** Density fallback when a food has none: assume water-like. */
const DEFAULT_DENSITY_G_PER_ML = 1.0;

function interval(grams: number, spread: number, basis: PortionEstimate['basis'], assumption: string): PortionEstimate {
  const clamped = Math.max(0.1, grams);
  return {
    gramsLikely: Number(clamped.toFixed(1)),
    gramsMin: Number((clamped * (1 - Math.min(spread, 0.95))).toFixed(1)),
    gramsMax: Number((clamped * (1 + spread)).toFixed(1)),
    basis,
    assumption,
  };
}

export interface PortionInput {
  food: CanonicalFood;
  item: ExtractedItem;
  /** True when the item came from a photo with no stated quantity. */
  fromImage?: boolean;
}

export function estimatePortion(db: FoodDb, { food, item, fromImage }: PortionInput): PortionEstimate {
  // The extractor may give us a structured quantity/unit; if it did not, fall
  // back to parsing the phrase itself. Both paths are deterministic.
  const parsed = parseQuantity(item.phrase);
  const quantity = item.quantity ?? parsed.value;
  const vague = item.quantity === undefined && parsed.vague;
  const unit = canonicalUnit(item.unit) ?? canonicalUnit(extractUnitToken(item.phrase, db, food));

  /* 1 — an explicit mass. Nothing to estimate. */
  if (quantity !== undefined && isMassUnit(unit)) {
    const grams = toGrams(quantity, unit!);
    return interval(grams, SPREAD.explicitMass, 'explicit_mass', `${quantity} ${unit} as stated`);
  }

  /* 2 — an explicit volume, converted through the food's own density. */
  if (quantity !== undefined && isVolumeUnit(unit)) {
    const ml = toMillilitres(quantity, unit!);
    const density = food.densityGPerMl ?? DEFAULT_DENSITY_G_PER_ML;
    const note = food.densityGPerMl
      ? `${ml} ml x ${density} g/ml`
      : `${ml} ml, assumed ${density} g/ml (no density on record)`;
    return interval(ml * density, SPREAD.explicitVolume, 'explicit_volume', note);
  }

  /* 3 — a household measure the food defines: "2 slices", "1 kase". */
  if (unit) {
    const measure = db.measureFor(food, unit);
    if (measure) {
      const n = quantity ?? 1;
      return interval(
        n * measure.grams,
        measure.spread,
        'household_measure',
        `${n} x ${measure.unit} = ${measure.grams} g each`,
      );
    }
  }

  /* 4 — a size adjective that names a measure row: "büyük boy", "medium". */
  const size = detectSize(item.phrase);
  if (size) {
    const measure = db.measureFor(food, size);
    if (measure) {
      const n = quantity ?? 1;
      return interval(
        n * measure.grams,
        measure.spread,
        'household_measure',
        `${size} = ${measure.grams} g`,
      );
    }
  }

  const fallback = db.defaultMeasure(food);

  /* 5 — a bare count against the food's default measure: "1 banana". */
  if (quantity !== undefined && fallback) {
    return interval(
      quantity * fallback.grams,
      fallback.spread,
      'household_measure',
      `${quantity} x ${fallback.unit} = ${fallback.grams} g each`,
    );
  }

  /* 6 — a hedge. Use the default portion but stop pretending we know it. */
  if (vague && fallback) {
    return interval(
      fallback.grams,
      SPREAD.vague,
      'vague_quantifier',
      `unspecified amount, assumed about one ${fallback.unit} (${fallback.grams} g)`,
    );
  }

  /* 7 — nothing stated at all. Widest interval we produce. */
  if (fallback) {
    return interval(
      fallback.grams,
      fromImage ? SPREAD.visualDefault : Math.max(fallback.spread, 0.3),
      fromImage ? 'visual_default' : 'household_measure',
      `no amount given, assumed one ${fallback.unit} (${fallback.grams} g)`,
    );
  }

  /* 8 — a food with no measures at all. The loader forbids this, but a future
     seed edit could reintroduce it and a silent 100 g default would be worse
     than an obviously wide guess. */
  return interval(100, 0.6, 'visual_default', 'no measures on record, assumed 100 g');
}

/**
 * Finds a unit token in the raw phrase when the extractor did not supply one.
 * Only units the food actually defines are considered, so "1 bardak çay"
 * matches tea's `glass` row rather than a generic 240 ml cup.
 */
function extractUnitToken(phrase: string, db: FoodDb, food: CanonicalFood): string | undefined {
  const tokens = phrase.toLowerCase().split(/[\s,]+/);
  for (const raw of tokens) {
    const unit = canonicalUnit(raw);
    if (!unit) continue;
    if (isMassUnit(unit) || isVolumeUnit(unit) || db.measureFor(food, unit)) return raw;
  }
  return undefined;
}
