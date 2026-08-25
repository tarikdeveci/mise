import { randomUUID } from 'node:crypto';
import type { FoodDb } from '../data/foodDb.js';
import type { LoggedItem, MealInput, MealLog, NutritionInterval } from '../domain/log.js';
import { logger } from '../obs/logger.js';
import { metrics, timed } from '../obs/metrics.js';
import { expandComposites } from './composite.js';
import { dispositionFor, scoreConfidence } from './confidence.js';
import { mergeModifierCompounds } from './extract/compound.js';
import type { Extractor } from './extract/types.js';
import type { GapLedger } from '../gaps/ledger.js';
import { canonicalUnit, foodPhraseOnly, normalizeText } from './normalize.js';
import { computeNutrition, sumIntervals, verifyTraceable } from './nutrition.js';
import { estimatePortion } from './portion/index.js';
import type { BarcodeFacts } from './portion/types.js';
import { buildQuestions } from './questions.js';
import type { CanonicalFood } from '../domain/food.js';
import type { AliasStore } from './resolve/aliasStore.js';
import type { LexicalIndex } from './resolve/lexical.js';
import { resolvePhrase, SELF_EVIDENT_SCORE, type Reranker } from './resolve/router.js';
import type { VectorIndex } from './resolve/vector.js';

export const PIPELINE_VERSION = 'v1.5.0';

export interface PipelineDeps {
  db: FoodDb;
  lexical: LexicalIndex;
  vector: VectorIndex;
  aliases: AliasStore;
  extractor: Extractor;
  reranker?: Reranker;
  /** Retrieval over USDA's full reference set; see `data/corpus.ts`. */
  corpus?: LexicalIndex;
  /** Materialises a corpus row into a food. Required if `corpus` is set. */
  corpusFood?: (id: string) => CanonicalFood | undefined;
  /**
   * Where everything this pipeline could not do gets written down, for
   * curation and for training sets. Optional: the eval builds a pipeline
   * without one, because a benchmark run is not production traffic.
   */
  gaps?: GapLedger;
}

export interface ProcessOptions {
  userId: string;
  traceId?: string;
  /**
   * A scanned package. When present the model is skipped entirely: the label
   * identifies the product and states the serving, so there is nothing left to
   * infer. This is the whole point of putting barcode at the top of the ladder.
   */
  barcode?: { food: CanonicalFood; facts: BarcodeFacts };
}

export interface Pipeline {
  process(input: MealInput, opts: ProcessOptions): Promise<MealLog>;
}

export function createPipeline(deps: PipelineDeps): Pipeline {
  const { db, extractor } = deps;

  /**
   * Whether a phrase names a single food we can cite a row for.
   *
   * Only the curated tier counts, and only at the bar the router treats as
   * self-evident. The corpus tier is deliberately excluded: thousands of loosely
   * worded USDA descriptions will match almost any two words put together, and
   * a merge justified by that is how "kıymalı makarna" would quietly stop
   * counting the mince.
   */
  const namesOneFood = (phrase: string): boolean => {
    const clean = foodPhraseOnly(phrase);
    if (db.byAlias(normalizeText(clean))) return true;
    return (deps.lexical.search(clean, 1)[0]?.score ?? 0) >= SELF_EVIDENT_SCORE;
  };

  return {
    async process(input, opts): Promise<MealLog> {
      const traceId = opts.traceId ?? randomUUID();
      const started = performance.now();
      const log = logger.child({ traceId, extractor: extractor.id });

      /* 0 — a scanned label answers both questions outright. */
      if (opts.barcode) {
        return barcodeLog(opts.barcode, input, opts, extractor, deps, started, traceId);
      }

      /* 1 — extraction. The only stage a model authors anything. */
      const extraction = await timed('extract', () => extractor.extract(input));

      if (extraction.notFood || extraction.items.length === 0) {
        metrics.inc('meal_log_total', { outcome: 'empty' });
        // Somebody wrote a sentence meaning to log a meal and got an empty log
        // back. That is worth a line in the ledger even though we cannot say
        // what the right answer was: `notFood` on a refusal is correct
        // behaviour, and on a real meal it is the worst failure the extractor
        // has, and only a human reading these can tell the two apart.
        if (input.text?.trim() && !opts.barcode) {
          deps.gaps?.record({
            kind: 'no_food_found',
            subject: input.text,
            sample: input.text,
            userId: opts.userId,
            ...(extraction.note !== undefined ? { note: extraction.note } : {}),
          });
        }
        return emptyLog(traceId, extractor, performance.now() - started, extraction.note);
      }

      /* 2a — put back together anything the extractor took apart that the words
         had joined. A dish named with an ingredient modifier is one food, and
         two items is a different meal from the one that was described. */
      const { items: joined, notes: joins } = mergeModifierCompounds(
        extraction.items, input.text, namesOneFood,
      );
      if (joins.length) log.debug({ joins }, 'rejoined modifier compounds');
      // A rejoin is a labelled extraction example: this text, that wrong split,
      // this correct single item. It is the cleanest fine-tuning pair the
      // system produces without ever asking the user anything.
      for (const note of joins) {
        deps.gaps?.record({
          kind: 'split_compound',
          subject: note,
          sample: input.text ?? note,
          userId: opts.userId,
          note,
        });
      }

      /* 2b — recipe expansion, before resolution so parts resolve individually. */
      const { items: expanded, notes } = expandComposites(joined);
      if (notes.length) log.debug({ notes }, 'expanded composite dishes');

      /* 3 — resolve, portion, compute, score. Per item, independently.

         Resolution is the only awaited step in this stage and the items genuinely
         do not depend on each other, so they run concurrently. Serially, a photo
         of five foods that each reach the verifier rung cost five round-trips
         end to end — measured at 20-65 s on real meal photographs, which is long
         enough that the phone shows a minute-long spinner. Concurrently the meal
         costs roughly its slowest single item.

         `Promise.all` preserves input order, so this changes latency only: the
         same input still produces byte-identical output, which the determinism
         test asserts. */
      const fromImage = Boolean(input.imageBase64);
      const resolutions = await Promise.all(
        expanded.map((extracted) =>
          timed('resolve', () =>
            resolvePhrase(deps, extracted.phrase, {
              userId: opts.userId,
              context: input.text ?? extracted.phrase,
              // A good extractor lifts preparation out of the phrase; the router
              // needs it back, or boiled egg resolves to raw egg.
              preparation: extracted.preparation,
            }),
          ),
        ),
      );

      const resolved: LoggedItem[] = [];

      for (const [index, extracted] of expanded.entries()) {
        const resolution = resolutions[index]!;
        // A corpus match is not in `db`, so the lookup has to consult both.
        // The order matters: curated always wins, and the corpus loader already
        // drops anything the seed covers, so the two cannot disagree.
        const food = resolution.foodId
          ? db.byId(resolution.foodId) ?? deps.corpusFood?.(resolution.foodId)
          : undefined;

        if (!food) {
          resolved.push({
            id: randomUUID(),
            extracted,
            resolution,
            foodId: null,
            foodName: null,
            source: null,
            portion: null,
            nutrition: null,
            confidence: scoreConfidence({ extracted, resolution, portion: null }),
          });
          continue;
        }

        const portion = estimatePortion({
          db,
          food,
          item: extracted,
          userId: opts.userId,
          aliases: deps.aliases,
          fromImage,
          // A scale reference the user said was in frame. The single best
          // accuracy-per-effort lever available on a plain 2D photo.
          reference: input.reference ?? 'none',
          ...(opts.barcode ? { barcode: opts.barcode } : {}),
        });
        const nutrition = computeNutrition(food, portion);
        recordPortionGaps(deps.gaps, opts.userId, food, extracted, portion.method);

        // The traceability assertion runs in production, not only in tests.
        // If it ever fires, a boundary leaked and the number is not ours to
        // show — we degrade the item to unresolved rather than display it.
        const traceable = verifyTraceable(food, portion, nutrition);
        if (!traceable.ok) {
          metrics.inc('nutrition_untraceable_total');
          log.error({ foodId: food.id, reason: traceable.reason }, 'E11: untraceable nutrition');
          resolved.push({
            id: randomUUID(),
            extracted,
            resolution: { ...resolution, method: 'unresolved', foodId: null },
            foodId: null, foodName: null, source: null, portion: null, nutrition: null,
            confidence: scoreConfidence({ extracted, resolution: { ...resolution, method: 'unresolved' }, portion: null }),
          });
          continue;
        }

        resolved.push({
          id: randomUUID(),
          extracted,
          resolution,
          foodId: food.id,
          foodName: food.name,
          source: food.source,
          portion,
          nutrition,
          confidence: scoreConfidence({ extracted, resolution, portion }),
        });
      }

      /* 4 — merge repeats of the same food. Eating bread twice is more bread,
         not two log lines the user has to reconcile. */
      const items = mergeByFood(resolved, db, deps.corpusFood);

      const totals = sumIntervals(
        items.map((i) => i.nutrition).filter((n): n is NutritionInterval => n !== null),
      );

      const questions = buildQuestions(items, {
        byId: (id) => db.byId(id) ?? deps.corpusFood?.(id),
      });
      const status = dispositionFor(items.map((i) => i.confidence.band));

      const latencyMs = Math.round(performance.now() - started);
      metrics.inc('meal_log_total', { outcome: status });
      metrics.observe('meal_latency_ms', latencyMs, { extractor: extractor.id });
      metrics.observe('meal_items', items.length);

      const usage = extractor.lastUsage?.();
      if (usage) metrics.observe('llm_cost_usd', usage.costUsd, { extractor: extractor.id });

      log.info(
        { status, items: items.length, kcal: totals.likely.kcal, latencyMs, questions: questions.length },
        'meal logged',
      );

      return {
        id: randomUUID(),
        status,
        items,
        totals,
        questions,
        provenance: {
          pipelineVersion: PIPELINE_VERSION,
          promptVersion: extractor.promptVersion,
          extractorId: extractor.id,
          model: extractor.model,
          traceId,
          latencyMs,
        },
        createdAt: new Date().toISOString(),
      };
    },
  };
}

/**
 * A meal built from a scanned label.
 *
 * Deliberately its own short path rather than a special case threaded through
 * the main one: there is no extraction, no retrieval and no ambiguity to
 * resolve, and pretending otherwise would obscure that this is the one route
 * with no inference anywhere in it.
 */
function barcodeLog(
  scanned: { food: CanonicalFood; facts: BarcodeFacts },
  input: MealInput,
  opts: ProcessOptions,
  extractor: Extractor,
  deps: PipelineDeps,
  started: number,
  traceId: string,
): MealLog {
  const { food, facts } = scanned;
  const quantity = input.text ? undefined : 1;

  const extracted = {
    phrase: facts.name,
    ...(quantity !== undefined ? { quantity } : {}),
    preparation: 'unknown' as const,
    confidence: 1,
  };

  const portion = estimatePortion({
    db: deps.db,
    food,
    item: extracted,
    userId: opts.userId,
    aliases: deps.aliases,
    fromImage: false,
    reference: 'none',
    barcode: facts,
  });

  const nutrition = computeNutrition(food, portion);
  const resolution = {
    method: 'barcode' as const,
    foodId: food.id,
    candidates: [{ foodId: food.id, name: food.name, score: 1, via: 'alias' as const }],
    margin: 1,
  };

  const item: LoggedItem = {
    id: randomUUID(),
    extracted,
    resolution,
    foodId: food.id,
    foodName: food.name,
    source: food.source,
    portion,
    nutrition,
    confidence: scoreConfidence({ extracted, resolution, portion }),
  };

  const latencyMs = Math.round(performance.now() - started);
  metrics.inc('meal_log_total', { outcome: 'barcode' });

  return {
    id: randomUUID(),
    status: dispositionFor([item.confidence.band]),
    items: [item],
    totals: sumIntervals([nutrition]),
    questions: [],
    provenance: {
      pipelineVersion: PIPELINE_VERSION,
      promptVersion: 'none',
      extractorId: 'barcode',
      model: 'none',
      traceId,
      latencyMs,
    },
    createdAt: new Date().toISOString(),
  };
}

function emptyLog(
  traceId: string,
  extractor: Extractor,
  latencyMs: number,
  note?: string,
): MealLog {
  const zero = sumIntervals([]);
  return {
    id: randomUUID(),
    status: 'confirmed',
    items: [],
    totals: zero,
    questions: note
      ? [{
          itemId: 'none',
          question: note,
          options: [],
          expectedKcalSwing: 0,
        }]
      : [],
    provenance: {
      pipelineVersion: PIPELINE_VERSION,
      promptVersion: extractor.promptVersion,
      extractorId: extractor.id,
      model: extractor.model,
      traceId,
      latencyMs: Math.round(latencyMs),
    },
    createdAt: new Date().toISOString(),
  };
}

/**
 * What the amount question could not answer.
 *
 * Both of these are keyed on the FOOD rather than on the phrase, because the
 * fix is a row in the measure table and that is per food. "Which foods keep
 * falling to a guess" is a list you can work through; "which sentences" is not.
 */
function recordPortionGaps(
  gaps: GapLedger | undefined,
  userId: string,
  food: CanonicalFood,
  extracted: LoggedItem['extracted'],
  method: string,
): void {
  if (!gaps) return;

  // A measure word the extractor read off real text and we cannot convert. The
  // count is dropped rather than applied to an unrelated measure, so the
  // amount silently falls back to a default — this is where that shows up.
  if (extracted.unit && !canonicalUnit(extracted.unit)) {
    gaps.record({
      kind: 'unknown_unit',
      subject: extracted.unit,
      sample: extracted.phrase,
      userId,
      observed: food.id,
    });
  }

  if (method === 'model_estimate') {
    gaps.record({
      kind: 'guessed_amount',
      subject: food.id,
      sample: extracted.phrase,
      userId,
      observed: food.name,
    });
  }
}

/** Sums portions of the same canonical food into one line. */
function mergeByFood(
  items: LoggedItem[],
  db: FoodDb,
  corpusFood?: (id: string) => CanonicalFood | undefined,
): LoggedItem[] {
  const out: LoggedItem[] = [];
  const byFood = new Map<string, LoggedItem>();

  for (const item of items) {
    if (!item.foodId || !item.portion) {
      out.push(item);
      continue;
    }
    const existing = byFood.get(item.foodId);
    if (!existing || !existing.portion) {
      byFood.set(item.foodId, item);
      continue;
    }

    const food = db.byId(item.foodId) ?? corpusFood?.(item.foodId);
    if (!food) continue;

    const merged = {
      gramsLikely: Number((existing.portion.gramsLikely + item.portion.gramsLikely).toFixed(1)),
      gramsMin: Number((existing.portion.gramsMin + item.portion.gramsMin).toFixed(1)),
      gramsMax: Number((existing.portion.gramsMax + item.portion.gramsMax).toFixed(1)),
      basis: existing.portion.basis,
      assumption: `${existing.portion.assumption}; plus ${item.portion.assumption}`,
      // If either half was read off a photo, the merged total inherits that
      // uncertainty — averaging it away would launder the weaker estimate.
      fromVision: existing.portion.fromVision || item.portion.fromVision,
      method: existing.portion.method,
    };

    byFood.set(item.foodId, {
      ...existing,
      portion: merged,
      nutrition: computeNutrition(food, merged),
      // Merging does not make us more certain; keep the weaker of the two.
      confidence:
        item.confidence.overall < existing.confidence.overall ? item.confidence : existing.confidence,
    });
  }

  return [...out, ...byFood.values()];
}
