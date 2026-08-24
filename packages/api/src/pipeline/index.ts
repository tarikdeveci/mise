import { randomUUID } from 'node:crypto';
import type { FoodDb } from '../data/foodDb.js';
import type {
  ClarificationQuestion, Confidence, LoggedItem, MealInput, MealLog, NutritionInterval,
} from '../domain/log.js';
import { logger } from '../obs/logger.js';
import { metrics, timed } from '../obs/metrics.js';
import { expandComposites } from './composite.js';
import { dispositionFor, scoreConfidence } from './confidence.js';
import type { Extractor } from './extract/types.js';
import { computeNutrition, sumIntervals, verifyTraceable } from './nutrition.js';
import { estimatePortion } from './portion.js';
import type { AliasStore } from './resolve/aliasStore.js';
import type { LexicalIndex } from './resolve/lexical.js';
import { resolvePhrase, type Reranker } from './resolve/router.js';
import type { VectorIndex } from './resolve/vector.js';

export const PIPELINE_VERSION = 'v1.3.0';

export interface PipelineDeps {
  db: FoodDb;
  lexical: LexicalIndex;
  vector: VectorIndex;
  aliases: AliasStore;
  extractor: Extractor;
  reranker?: Reranker;
}

export interface ProcessOptions {
  userId: string;
  traceId?: string;
}

export interface Pipeline {
  process(input: MealInput, opts: ProcessOptions): Promise<MealLog>;
}

export function createPipeline(deps: PipelineDeps): Pipeline {
  const { db, extractor } = deps;

  return {
    async process(input, opts): Promise<MealLog> {
      const traceId = opts.traceId ?? randomUUID();
      const started = performance.now();
      const log = logger.child({ traceId, extractor: extractor.id });

      /* 1 — extraction. The only stage a model authors anything. */
      const extraction = await timed('extract', () => extractor.extract(input));

      if (extraction.notFood || extraction.items.length === 0) {
        metrics.inc('meal_log_total', { outcome: 'empty' });
        return emptyLog(traceId, extractor, performance.now() - started, extraction.note);
      }

      /* 2 — recipe expansion, before resolution so parts resolve individually. */
      const { items: expanded, notes } = expandComposites(extraction.items);
      if (notes.length) log.debug({ notes }, 'expanded composite dishes');

      /* 3 — resolve, portion, compute, score. Per item, independently. */
      const fromImage = Boolean(input.imageBase64);
      const resolved: LoggedItem[] = [];

      for (const extracted of expanded) {
        const resolution = await timed('resolve', () =>
          resolvePhrase(deps, extracted.phrase, {
            userId: opts.userId,
            context: input.text ?? extracted.phrase,
            // A good extractor lifts preparation out of the phrase; the router
            // needs it back, or boiled egg resolves to raw egg.
            preparation: extracted.preparation,
          }),
        );

        const food = resolution.foodId ? db.byId(resolution.foodId) : undefined;

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

        const portion = estimatePortion(db, { food, item: extracted, fromImage });
        const nutrition = computeNutrition(food, portion);

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
      const items = mergeByFood(resolved, db);

      const totals = sumIntervals(
        items.map((i) => i.nutrition).filter((n): n is NutritionInterval => n !== null),
      );

      const questions = buildQuestions(items, db);
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

/** Sums portions of the same canonical food into one line. */
function mergeByFood(items: LoggedItem[], db: FoodDb): LoggedItem[] {
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

    const food = db.byId(item.foodId);
    if (!food) continue;

    const merged = {
      gramsLikely: Number((existing.portion.gramsLikely + item.portion.gramsLikely).toFixed(1)),
      gramsMin: Number((existing.portion.gramsMin + item.portion.gramsMin).toFixed(1)),
      gramsMax: Number((existing.portion.gramsMax + item.portion.gramsMax).toFixed(1)),
      basis: existing.portion.basis,
      assumption: `${existing.portion.assumption}; plus ${item.portion.assumption}`,
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

/**
 * Builds at most two clarification questions, ranked by how many calories the
 * answer would move.
 *
 * Ranking by kcal swing rather than by confidence is deliberate: being unsure
 * whether the tea glass was 100 ml or 120 ml is not worth a tap, while being
 * unsure whether the potato was boiled or fried is worth several.
 */
function buildQuestions(items: LoggedItem[], db: FoodDb): ClarificationQuestion[] {
  const questions: ClarificationQuestion[] = [];

  for (const item of items) {
    if (item.confidence.band === 'high') continue;

    if (item.confidence.weakest === 'resolution' || !item.foodId) {
      const options = item.resolution.candidates.slice(0, 4).map((c) => ({
        label: db.byId(c.foodId)?.name ?? c.name,
        foodId: c.foodId,
        grams: null,
      }));
      if (options.length < 2) continue;

      const grams = item.portion?.gramsLikely ?? 100;
      const kcals = options
        .map((o) => (o.foodId ? (db.byId(o.foodId)?.per100g.kcal ?? 0) * grams / 100 : 0));
      questions.push({
        itemId: item.id,
        question: `Which "${item.extracted.phrase}" did you have?`,
        options,
        expectedKcalSwing: Number((Math.max(...kcals) - Math.min(...kcals)).toFixed(1)),
      });
      continue;
    }

    if (item.confidence.weakest === 'portion' && item.foodId && item.portion) {
      const food = db.byId(item.foodId);
      if (!food) continue;
      const options = food.measures.slice(0, 4).map((m) => ({
        label: `${m.unit} (${m.grams} g)`,
        foodId: item.foodId,
        grams: m.grams,
      }));
      if (options.length === 0) continue;

      const swing = ((item.nutrition?.max.kcal ?? 0) - (item.nutrition?.min.kcal ?? 0));
      questions.push({
        itemId: item.id,
        question: `How much ${item.foodName ?? item.extracted.phrase}?`,
        options,
        expectedKcalSwing: Number(swing.toFixed(1)),
      });
    }
  }

  return questions.sort((a, b) => b.expectedKcalSwing - a.expectedKcalSwing).slice(0, 2);
}
