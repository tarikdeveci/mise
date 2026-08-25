import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import { loadFoodDb, type FoodDb } from '../data/foodDb.js';
import { loadFoodCorpus } from '../data/corpus.js';
import type { CanonicalFood } from '../domain/food.js';
import { MealInput, type MealLog } from '../domain/log.js';
import { logger } from '../obs/logger.js';
import { metrics } from '../obs/metrics.js';
import { createGapLedger, type GapLedger } from '../gaps/ledger.js';
import { renderGapReport, renderJsonl, summarise } from '../gaps/report.js';
import { isGapKind } from '../gaps/types.js';
import { addItem, applyCorrection } from '../pipeline/correct.js';
import { createPipeline, PIPELINE_VERSION, type Pipeline } from '../pipeline/index.js';
import {
  createExtractor, availableExtractors, bestAvailableExtractor, isExtractorId,
} from '../pipeline/extract/registry.js';
import { VisionExtractionUnavailable, withRuleFallback } from '../pipeline/extract/fallback.js';
import { createAliasStore, GLOBAL_ALIAS_SEED, type AliasStore } from '../pipeline/resolve/aliasStore.js';
import { buildLexicalIndex } from '../pipeline/resolve/lexical.js';
import { createGeminiReranker } from '../pipeline/resolve/reranker.js';
import { buildVectorIndex, type VectorIndex } from '../pipeline/resolve/vector.js';
import { createIdempotencyStore, IdempotencyConflict } from './idempotency.js';
import { lookupBarcode, BarcodeNotFound } from '../data/openFoodFacts.js';

/**
 * HTTP surface.
 *
 * Deliberately small, and two of the routes are there for reasons a food
 * logger would not obviously need: `/trace`, so any number the app shows can
 * be walked back to the database row it came from, and `/v1/gaps`, so what the
 * pipeline could NOT do is as readable as what it did.
 */

const CreateMealBody = MealInput;

/**
 * Upper bound on a corrected mass.
 *
 * Not a guess about appetite — a guard on a text field. A slipped digit turns
 * 200 g into 2000 g, and the arithmetic downstream is perfectly happy to
 * report 7,000 kcal for it.
 */
const MAX_CORRECTION_GRAMS = 5000;
/** Search results below this are string noise, not useful correction choices. */
const FOOD_SEARCH_FLOOR = 0.2;

const CorrectionBody = z
  .object({
    itemId: z.string().min(1),
    /**
     * The food the user actually meant. Must exist — we never store a
     * free-text guess. Omitted when they are only changing the amount.
     */
    foodId: z.string().min(1).optional(),
    /** Corrected mass. "My usual" is a portion, not only a food. */
    grams: z.number().positive().max(MAX_CORRECTION_GRAMS).optional(),
  })
  .refine((v) => v.foodId !== undefined || v.grams !== undefined, {
    message: 'Provide `foodId`, `grams`, or both.',
  });

/**
 * A food the extractor never produced.
 *
 * `foodId` is required and `phrase` is not, which is the opposite way round
 * from how a person describes a missing item — and deliberate. Free text is a
 * search query on the way in; the thing that gets logged is always a row
 * someone can cite. The phrase is kept because it is what the alias is keyed
 * on, so typing a word the resolver has never handled teaches it that word.
 */
const AddItemBody = z.object({
  foodId: z.string().min(1),
  grams: z.number().positive().max(MAX_CORRECTION_GRAMS).optional(),
  phrase: z.string().trim().min(1).max(120).optional(),
});

const FoodSearchQuery = z.object({
  q: z.string().trim().min(2).max(100),
  limit: z.coerce.number().int().min(1).max(12).default(8),
});

export interface FoodSearchHit {
  foodId: string;
  name: string;
  localizedName?: string;
  source: string;
  kcalPer100g: number;
  score: number;
  tier: 'curated' | 'reference';
}

/**
 * A correction is the only place a gap arrives with its answer attached.
 *
 * Everywhere else the ledger records what we could not do; here it records
 * what we did, what the person actually meant, and — for identity — the closed
 * shortlist we chose from. That is a training pair as it stands, which is why
 * these are the records the report counts as labelled.
 *
 * Confirmations are deliberately not recorded. Tapping the food we already
 * picked, or setting the amount we already estimated, is the system being
 * right; filing it as a gap would inflate the pile with our successes.
 */
function recordCorrectionGaps(
  gaps: GapLedger | undefined,
  userId: string,
  item: MealLog['items'][number],
  foodId: string,
  grams: number | undefined,
): void {
  if (!gaps) return;

  if (item.foodId !== foodId) {
    gaps.record({
      kind: 'corrected_food',
      subject: item.extracted.phrase,
      sample: item.extracted.phrase,
      userId,
      observed: item.foodId ?? undefined,
      expected: foodId,
      candidates: item.resolution.candidates
        .slice(0, 5)
        .map((c) => ({ foodId: c.foodId, name: c.name, score: c.score })),
    });
  }

  const estimated = item.portion?.gramsLikely;
  // Only a move outside our own stated tolerance counts. Inside it, the user
  // agreed with us to within the precision we claimed.
  if (grams !== undefined && estimated !== undefined && estimated > 0
      && Math.abs(grams - estimated) / estimated > 0.1) {
    gaps.record({
      kind: 'corrected_amount',
      subject: foodId,
      sample: item.extracted.phrase,
      userId,
      observed: item.portion?.method,
      grams: { estimated, corrected: grams },
    });
  }
}

/** Meal logs, kept in memory. A real deployment swaps this for Postgres. */
interface MealStore {
  put(log: MealLog, userId: string): void;
  get(id: string): { log: MealLog; userId: string } | undefined;
  list(userId: string, limit: number): MealLog[];
  /** Drops every meal this user logged. Returns how many. */
  forget(userId: string): number;
}

function createMealStore(): MealStore {
  const byId = new Map<string, { log: MealLog; userId: string }>();
  return {
    put: (log, userId) => byId.set(log.id, { log, userId }),
    get: (id) => byId.get(id),
    list: (userId, limit) =>
      [...byId.values()]
        .filter((r) => r.userId === userId)
        .sort((a, b) => b.log.createdAt.localeCompare(a.log.createdAt))
        .slice(0, limit)
        .map((r) => r.log),
    forget: (userId) => {
      let removed = 0;
      for (const [id, rec] of byId) {
        if (rec.userId !== userId) continue;
        byId.delete(id);
        removed++;
      }
      return removed;
    },
  };
}

export interface ServerDeps {
  db: FoodDb;
  pipeline: Pipeline;
  aliases: AliasStore;
  vector: VectorIndex;
  extractorId: string;
  /** Whether the configured extractor can actually read an image. */
  supportsVision: boolean;
  /**
   * Materialises a USDA corpus row. Needed here, not only in the pipeline:
   * corpus foods appear in the candidate lists the app shows, so a correction
   * can point at one and must be able to resolve it.
   */
  corpusFood?: (id: string) => CanonicalFood | undefined;
  /** Number of searchable reference rows, reported separately from curated foods. */
  corpusSize?: number;
  /** User-facing search across the curated seed and wider reference corpus. */
  foodSearch?: (query: string, limit: number) => FoodSearchHit[];
  /** The ledger of what mise did not know. Absent means collection is off. */
  gaps?: GapLedger;
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    // Meal photos are large; 12 MB covers a full-resolution phone JPEG in base64.
    bodyLimit: 12 * 1024 * 1024,
    genReqId: () => randomUUID(),
    // Upstream providers can hang without ever failing. Without a ceiling, one
    // stuck vision call holds its socket until the process restarts, and the
    // client's own deadline just abandons a request the server keeps working on.
    // Sized above the client's photo deadline so the phone gives up first and
    // gets the better error message.
    requestTimeout: 60_000,
    connectionTimeout: 65_000,
  });

  await app.register(cors, { origin: true });

  const meals = createMealStore();
  const idempotency = createIdempotencyStore<MealLog>();
  const curatedFoodSearch = buildLexicalIndex(deps.db);

  /** Device-scoped identity. Real auth is out of scope; see README. */
  const userIdOf = (headers: Record<string, unknown>): string =>
    String(headers['x-user-id'] ?? 'anonymous');

  app.addHook('onRequest', async (req) => {
    req.log = logger.child({ reqId: req.id, route: req.url }) as never;
  });

  // Writes are debounced, so a restart could otherwise drop the last couple of
  // seconds of ledger. Over many deploys that biases the record toward
  // whatever time of day nobody deploys, which is a silly way to lose data.
  app.addHook('onClose', async () => { deps.gaps?.flush(); });

  app.addHook('onResponse', async (req, reply) => {
    metrics.observe('http_duration_ms', reply.elapsedTime, {
      route: req.routeOptions.url ?? req.url,
      status: String(reply.statusCode),
    });
    metrics.inc('http_requests_total', {
      route: req.routeOptions.url ?? req.url,
      status: String(reply.statusCode),
    });
  });

  /**
   * Typed error envelope. Clients get a machine-readable `code` and a message
   * that is safe to display; stack traces and provider errors stay in the log.
   */
  app.setErrorHandler((err, req, reply) => {
    const traceId = String(req.id);

    if (err instanceof IdempotencyConflict) {
      return reply.status(409).send({
        error: { code: 'idempotency_key_reused', message: err.message, traceId },
      });
    }
    if (err instanceof z.ZodError) {
      return reply.status(400).send({
        error: {
          code: 'invalid_request',
          message: 'Request body failed validation.',
          details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          traceId,
        },
      });
    }
    if (err instanceof BarcodeNotFound) {
      return reply.status(404).send({
        error: {
          code: 'barcode_not_found',
          message: `${err.why}. Try describing it or taking a photo instead.`,
          traceId,
        },
      });
    }
    if ((err as { statusCode?: number }).statusCode === 413) {
      return reply.status(413).send({
        error: { code: 'payload_too_large', message: 'Image exceeds the 12 MB limit.', traceId },
      });
    }
    if (err instanceof VisionExtractionUnavailable) {
      logger.warn({ traceId }, 'photo extractor temporarily unavailable');
      metrics.inc('vision_extraction_unavailable_total');
      return reply.status(503).send({
        error: {
          code: 'vision_temporarily_unavailable',
          message:
            'Photo analysis is temporarily unavailable. Add a short description of the meal ' +
            'and try again, or retry the photo later.',
          traceId,
        },
      });
    }

    // Framework-level client errors (malformed JSON, bad Content-Length, wrong
    // content type) carry their own 4xx status. Reporting them as 500 tells the
    // client the server is broken and to retry, when the request is what needs
    // fixing — and it hides real 5xx incidents in the same bucket.
    const framework = err as { statusCode?: number; code?: string; message?: string };
    const status = framework.statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const message = framework.message ?? 'Bad request.';
      logger.warn({ message, code: framework.code, traceId }, 'client error');
      return reply.status(status).send({
        error: { code: framework.code ?? 'bad_request', message, traceId },
      });
    }

    logger.error({ err, traceId }, 'unhandled request error');
    metrics.inc('http_errors_total', { route: req.routeOptions.url ?? req.url });
    return reply.status(500).send({
      error: { code: 'internal_error', message: 'Something went wrong on our side.', traceId },
    });
  });

  /* ───────────────────────────── routes ───────────────────────────── */

  app.get('/healthz', async () => ({
    status: 'ok',
    pipelineVersion: PIPELINE_VERSION,
    extractor: deps.extractorId,
    // Advisory capability state for the app. Native camera/library controls
    // remain usable offline; this flag lets the UI explain that the current
    // server cannot analyse the attachment yet.
    visionAvailable: deps.supportsVision,
    vectorRetrieval: deps.vector.available,
    // Keep `foods` for older clients, and make the two confidence tiers visible.
    foods: deps.db.all.length + (deps.corpusSize ?? 0),
    curatedFoods: deps.db.all.length,
    referenceFoods: deps.corpusSize ?? 0,
    searchableFoods: deps.db.all.length + (deps.corpusSize ?? 0),
    extractorsAvailable: availableExtractors(),
  }));

  app.get('/metrics', async () => metrics.snapshot());

  /**
   * Searchable correction vocabulary.
   *
   * Resolver candidates are deliberately conservative and may contain no
   * offerable answer. A person correcting one visible item needs recall, not
   * another automatic decision: this route searches the full verified food
   * vocabulary and returns rows to choose from. The correction endpoint still
   * accepts only a real row id, so free text never authors nutrition values.
   */
  app.get('/v1/foods/search', async (req) => {
    const { q, limit } = FoodSearchQuery.parse(req.query);
    const fallback = (query: string, take: number): FoodSearchHit[] =>
      curatedFoodSearch.search(query, take * 2)
        .filter((candidate) => candidate.score >= FOOD_SEARCH_FLOOR)
        .slice(0, take)
        .flatMap((candidate) => {
        const food = deps.db.byId(candidate.foodId);
        if (!food) return [];
        return [{
          foodId: food.id,
          name: food.name,
          ...(food.names.tr ? { localizedName: food.names.tr } : {}),
          source: food.source,
          kcalPer100g: food.per100g.kcal,
          score: candidate.score,
          tier: 'curated' as const,
        }];
      });

    return {
      query: q,
      foods: (deps.foodSearch ?? fallback)(q, limit),
    };
  });

  /**
   * What mise did not know, and what would fix it.
   *
   * The eval set is saturated — every case in it passes — so it can no longer
   * say what to build next. This can: it is the same question asked of real
   * traffic instead of a set the author wrote. Three formats because it has
   * three readers: a person deciding what to curate (`text`), a dashboard
   * (`json`), and a training run (`jsonl`).
   */
  app.get('/v1/gaps', async (req, reply) => {
    const q = req.query as { format?: string; kind?: string; limit?: string };
    if (!deps.gaps?.enabled) {
      return reply.status(404).send({
        error: {
          code: 'gaps_disabled',
          message: deps.gaps?.reason ?? 'Gap collection is off on this server (GAPS=off).',
          traceId: String(req.id),
        },
      });
    }
    if (q.kind !== undefined && !isGapKind(q.kind)) {
      return reply.status(400).send({
        error: { code: 'unknown_kind', message: `${q.kind} is not a gap kind.`, traceId: String(req.id) },
      });
    }

    const entries = deps.gaps.entries({
      ...(q.kind !== undefined && isGapKind(q.kind) ? { kind: q.kind } : {}),
      ...(q.limit ? { limit: Math.min(2000, Math.max(1, Number(q.limit) || 100)) } : {}),
    });
    // Summarised over what is actually being returned, so a filtered response
    // never carries the whole ledger's percentages over a slice of its rows.
    const summary = summarise(entries, deps.gaps.stats());

    if (q.format === 'jsonl') {
      return reply.type('application/x-ndjson').send(renderJsonl(entries));
    }
    if (q.format === 'text') {
      return reply.type('text/plain; charset=utf-8').send(renderGapReport(summary, entries));
    }
    return { summary, entries };
  });

  /**
   * Look up a scanned package without logging it.
   *
   * Separate from meal creation so the app can show what it found and let the
   * user confirm the product and the amount before anything is written. A
   * barcode is exact, but "exact about the wrong shelf item" is still wrong.
   */
  app.get('/v1/barcode/:code', async (req) => {
    const { code } = req.params as { code: string };
    const { food, facts } = await lookupBarcode(code);
    return {
      barcode: facts.code,
      name: facts.name,
      source: food.source,
      per100g: food.per100g,
      servingGrams: facts.servingGrams ?? null,
    };
  });

  app.post('/v1/meals', async (req, reply) => {
    const body = CreateMealBody.parse(req.body);
    const userId = userIdOf(req.headers as Record<string, unknown>);
    const key = req.headers['idempotency-key'];

    // Refuse a photo we cannot read, loudly. Previously this path returned an
    // empty log with status "confirmed" and 0 kcal — the system reporting
    // certainty it did not have, which is the exact failure this product
    // exists to avoid.
    if (body.imageBase64 && !deps.supportsVision) {
      return reply.status(422).send({
        error: {
          code: 'vision_unavailable',
          message:
            'This server is running the text-only extractor, so it cannot read photos. ' +
            'Describe the meal instead, or start the API with a vision provider key.',
          traceId: String(req.id),
        },
      });
    }

    if (typeof key === 'string' && key.length > 0) {
      const cached = idempotency.get(key, req.body);
      if (cached) {
        metrics.inc('idempotent_replay_total');
        return reply.header('Idempotent-Replay', 'true').send(cached);
      }
    }

    // A scanned label is looked up here rather than inside the pipeline: it is
    // network I/O with its own failure modes, and the pipeline stays a pure
    // transformation over data it was handed.
    const scanned = body.barcode ? await lookupBarcode(body.barcode) : undefined;

    const log = await deps.pipeline.process(body, {
      userId,
      traceId: String(req.id),
      ...(scanned ? { barcode: scanned } : {}),
    });
    meals.put(log, userId);

    if (typeof key === 'string' && key.length > 0) idempotency.put(key, req.body, log, userId);

    return reply.status(201).send(log);
  });

  app.get('/v1/meals', async (req) => {
    const userId = userIdOf(req.headers as Record<string, unknown>);
    const limit = Number((req.query as { limit?: string }).limit ?? 20);
    return { meals: meals.list(userId, Math.min(100, Math.max(1, limit))) };
  });

  app.get('/v1/meals/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = meals.get(id);
    if (!found) {
      return reply.status(404).send({
        error: { code: 'not_found', message: `No meal with id ${id}.`, traceId: String(req.id) },
      });
    }
    return found.log;
  });

  /**
   * Records a user correction, and applies it to the meal in front of them.
   *
   * Two jobs, deliberately in one call. The alias is what makes accuracy
   * improve with use: the same phrase from the same user resolves instantly and
   * identically next time, with no model call at all. The updated log is what
   * makes the correction visible *now* — the client used to re-log the meal
   * from its item phrases to see the change, which lost the photograph, could
   * not move a stated amount at all, and renumbered every item mid-question.
   * See `pipeline/correct.ts`.
   */
  app.post('/v1/meals/:id/corrections', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = CorrectionBody.parse(req.body);
    const userId = userIdOf(req.headers as Record<string, unknown>);

    const found = meals.get(id);
    if (!found) {
      return reply.status(404).send({
        error: { code: 'not_found', message: `No meal with id ${id}.`, traceId: String(req.id) },
      });
    }

    const item = found.log.items.find((i) => i.id === body.itemId);
    if (!item) {
      return reply.status(404).send({
        error: { code: 'item_not_found', message: `No item ${body.itemId} in meal ${id}.`, traceId: String(req.id) },
      });
    }

    // An amount-only correction keeps whatever the item already resolved to.
    const foodId = body.foodId ?? item.foodId;
    if (!foodId) {
      return reply.status(400).send({
        error: {
          code: 'food_required',
          message: 'This item has no food yet, so there is nothing to weigh. Pick a food first.',
          traceId: String(req.id),
        },
      });
    }

    // Refuse to remember a correction pointing at a food that does not exist —
    // a poisoned alias is worse than no alias, because it is silent and fast.
    // The corpus tier counts: the app offers corpus rows as alternatives, so
    // rejecting them here made a visible, tappable option fail on tap.
    const food = deps.db.byId(foodId) ?? deps.corpusFood?.(foodId);
    if (!food) {
      return reply.status(400).send({
        error: { code: 'unknown_food', message: `${foodId} is not in the food database.`, traceId: String(req.id) },
      });
    }

    const applied = applyCorrection({
      log: found.log,
      itemId: body.itemId,
      food,
      ...(body.grams !== undefined ? { grams: body.grams } : {}),
      db: deps.db,
      foodById: (candidateId) => deps.db.byId(candidateId) ?? deps.corpusFood?.(candidateId),
      aliases: deps.aliases,
      userId,
    });
    if (!applied.ok) {
      metrics.inc('correction_rejected_total');
      logger.error({ mealId: id, itemId: body.itemId, reason: applied.reason }, 'correction rejected');
      return reply.status(422).send({
        error: { code: 'correction_failed', message: applied.reason, traceId: String(req.id) },
      });
    }

    const entry = deps.aliases.record(userId, item.extracted.phrase, foodId, body.grams);
    meals.put(applied.log, found.userId);
    metrics.inc('correction_total', { weakestStage: item.confidence.weakest });
    recordCorrectionGaps(deps.gaps, userId, item, foodId, body.grams);

    logger.info(
      { mealId: id, itemId: body.itemId, from: item.foodId, to: foodId, grams: body.grams, hits: entry.hits },
      'correction recorded',
    );

    return {
      recorded: true,
      phrase: item.extracted.phrase,
      foodId,
      hits: entry.hits,
      /** The meal as it now stands, so the client never has to re-log to see it. */
      log: applied.log,
    };
  });

  /**
   * Adds a food to a meal that was logged without it.
   *
   * The corrections route can only reach lines that exist, so until now a
   * plate read as four items when there were five had no repair: the person
   * could change every item on the screen and still not record the one that
   * was missing. Their options were to leave it out or to log the meal twice.
   *
   * Deliberately not folded into `/corrections`. That route answers "this line
   * is wrong"; this one answers "there was another line". They differ in what
   * they need (no `itemId` here — there is no item yet), in what they mean for
   * the model (a wrong pick against a miss, two different gap kinds), and in
   * what they can fail on, and a single endpoint switching on the absence of a
   * field would hide all three.
   */
  app.post('/v1/meals/:id/items', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = AddItemBody.parse(req.body);
    const userId = userIdOf(req.headers as Record<string, unknown>);

    const found = meals.get(id);
    if (!found) {
      return reply.status(404).send({
        error: { code: 'not_found', message: `No meal with id ${id}.`, traceId: String(req.id) },
      });
    }

    // Same rule as a correction, for the same reason: free text is a search
    // query, never a nutrition source. Only a row we can cite gets logged.
    const food = deps.db.byId(body.foodId) ?? deps.corpusFood?.(body.foodId);
    if (!food) {
      return reply.status(400).send({
        error: { code: 'unknown_food', message: `${body.foodId} is not in the food database.`, traceId: String(req.id) },
      });
    }

    const added = addItem({
      log: found.log,
      food,
      ...(body.phrase !== undefined ? { phrase: body.phrase } : {}),
      ...(body.grams !== undefined ? { grams: body.grams } : {}),
      db: deps.db,
      foodById: (candidateId) => deps.db.byId(candidateId) ?? deps.corpusFood?.(candidateId),
      aliases: deps.aliases,
      userId,
    });
    if (!added.ok) {
      metrics.inc('item_add_rejected_total');
      logger.error({ mealId: id, foodId: body.foodId, reason: added.reason }, 'item add rejected');
      return reply.status(422).send({
        error: { code: 'add_failed', message: added.reason, traceId: String(req.id) },
      });
    }

    // Only when they typed a word of their own. Aliasing a food's own name to
    // its own row teaches nothing and pads the table with rows that would have
    // resolved anyway.
    if (body.phrase !== undefined) {
      deps.aliases.record(userId, body.phrase, food.id, body.grams);
    }

    meals.put(added.log, found.userId);
    metrics.inc('item_added_total');

    // The extractor's clearest miss, with the answer attached: a food that was
    // there, the words for it, and the row it should have reached. Recorded
    // only when the user supplied the words — the food's own name says nothing
    // about what the extractor was looking at and would train on noise.
    if (body.phrase !== undefined) {
      deps.gaps?.record({
        kind: 'missed_item',
        subject: body.phrase,
        sample: body.phrase,
        userId,
        expected: food.id,
      });
    }

    logger.info({ mealId: id, itemId: added.itemId, foodId: food.id, grams: body.grams }, 'item added');

    return reply.status(201).send({
      added: true,
      /** So the app can point at the line it just created. */
      itemId: added.itemId,
      log: added.log,
    });
  });

  /**
   * Erasure. Everything this user's device produced, removed everywhere it
   * landed — not only from the meals table.
   *
   * Four stores hold data derived from one person, and three of them are easy
   * to forget about:
   *
   *   meals         the logs themselves
   *   idempotency   a cached copy of a log, replayable by key. Deleting the
   *                 meal and leaving this behind erases nothing
   *   aliases       their corrections. A correction is a sentence they typed
   *                 and a judgement they made, which is derived personal data
   *   gap ledger    the phrases that defeated the resolver, same argument
   *
   * The receipt is itemised rather than a bare 204 because the guarantees
   * differ per store, and one of them is deliberately partial: a gap row other
   * people also hit keeps its aggregate and loses only this person's
   * pseudonym. `GapLedger.forget` says why at length. The golden and photo
   * eval sets are fixtures in the repository, written by hand and never fed
   * from traffic, so there is nothing of anyone's in them to remove.
   *
   * The user id must be sent explicitly. Falling back to "anonymous" here —
   * the default everywhere else — would let a header-less request erase the
   * shared anonymous bucket, which is the one destructive accident available
   * on this API.
   */
  app.delete('/v1/me', async (req, reply) => {
    const header = (req.headers as Record<string, unknown>)['x-user-id'];
    const userId = typeof header === 'string' ? header.trim() : '';
    if (!userId) {
      return reply.status(400).send({
        error: {
          code: 'user_required',
          message: 'Send the x-user-id header naming the account to erase.',
          traceId: String(req.id),
        },
      });
    }

    const erased = {
      meals: meals.forget(userId),
      cachedResponses: idempotency.forget(userId),
      corrections: deps.aliases.forget(userId),
      gapRows: deps.gaps?.forget(userId) ?? { deleted: 0, anonymised: 0 },
    };

    metrics.inc('erasure_total');
    // Counts, and the id that was just erased. Without the id there would be
    // no way to answer "did that deletion actually run" — which is a question
    // an erasure request has to be able to answer.
    logger.info(
      {
        userId,
        meals: erased.meals,
        cachedResponses: erased.cachedResponses,
        corrections: erased.corrections,
        gapRowsDeleted: erased.gapRows.deleted,
        gapRowsAnonymised: erased.gapRows.anonymised,
      },
      'user data erased',
    );

    return {
      erased: {
        meals: erased.meals,
        cachedResponses: erased.cachedResponses,
        corrections: erased.corrections,
        gapRows: erased.gapRows.deleted,
      },
      retained: {
        sharedGapRows: erased.gapRows.anonymised,
        note:
          'Gap rows other people also hit keep their aggregate counts; this ' +
          'account is no longer among them. Global aliases are curated ' +
          'defaults, not corrections, and are untouched.',
      },
    };
  });

  /**
   * The provenance trace for one meal.
   *
   * Every figure the app displays can be walked back through this endpoint to
   * the exact database row and arithmetic that produced it. It is what makes
   * "we do not hallucinate nutrition" an auditable claim rather than a slogan.
   */
  app.get('/v1/meals/:id/trace', async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = meals.get(id);
    if (!found) {
      return reply.status(404).send({
        error: { code: 'not_found', message: `No meal with id ${id}.`, traceId: String(req.id) },
      });
    }

    return {
      mealId: id,
      provenance: found.log.provenance,
      items: found.log.items.map((item) => {
        const food = item.foodId
          ? deps.db.byId(item.foodId) ?? deps.corpusFood?.(item.foodId)
          : undefined;
        return {
          phrase: item.extracted.phrase,
          extracted: item.extracted,
          resolution: {
            method: item.resolution.method,
            margin: item.resolution.margin,
            consideredCandidates: item.resolution.candidates,
          },
          portion: item.portion,
          arithmetic: food && item.portion
            ? `${food.per100g.kcal} kcal/100g x ${item.portion.gramsLikely} g / 100 = ${item.nutrition?.likely.kcal} kcal`
            : null,
          source: food?.source ?? null,
          confidence: item.confidence,
        };
      }),
    };
  });

  return app;
}

/** Wires every dependency and returns a ready-to-listen server. */
export async function createApp(): Promise<FastifyInstance> {
  // Pick the best extractor the credentials allow unless one was named. The
  // old `?? 'rules'` default meant a server holding a working vision key still
  // could not read a photo.
  const requested = process.env.EXTRACTOR ?? bestAvailableExtractor();
  if (!isExtractorId(requested)) {
    throw new Error(`EXTRACTOR="${requested}" is not one of: rules, gemini, openai, anthropic`);
  }

  const db = loadFoodDb();
  const lexical = buildLexicalIndex(db);
  // The second tier. Loaded once at boot: 13k+ rows index in well under a
  // second and the alternative is a stall on the first unknown food.
  const corpusData = loadFoodCorpus(new Set(db.all.map((f) => f.id)));
  const corpus = corpusData.available ? buildLexicalIndex({
    surfaces: corpusData.surfaces,
    byId: (id) => corpusData.get(id),
  }) : undefined;
  const vector = await buildVectorIndex(db);
  const aliases = createAliasStore(GLOBAL_ALIAS_SEED);
  // Model-backed extractors get the rule tier as a safety net; the rule tier
  // is already the safety net, so wrapping it in itself would be noise.
  const primary = await createExtractor(requested);
  const extractor = requested === 'rules' ? primary : withRuleFallback(primary);
  // The verifier for rung 5. Undefined without a key, and the router falls
  // back to accepting a plausible-but-unverified match rather than refusing
  // everything.
  const reranker = createGeminiReranker();
  // The corpus is always available as a closed list for user confirmation.
  // Automatic acceptance remains gated on the verifier.
  const corpusWired = Boolean(corpus);
  const corpusAutoResolve = Boolean(corpus && reranker);
  const corpusFood = (id: string): CanonicalFood | undefined => corpusData.get(id);

  const foodSearch = (query: string, limit: number): FoodSearchHit[] => {
    const ranked = [
      ...lexical.search(query, limit * 2).map((candidate) => ({ candidate, tier: 'curated' as const })),
      ...(corpus
        ? corpus.search(query, limit * 2).map((candidate) => ({ candidate, tier: 'reference' as const }))
        : []),
    ].sort((a, b) => b.candidate.score - a.candidate.score
      || (a.tier === 'curated' ? -1 : 1));

    const seen = new Set<string>();
    const hits: FoodSearchHit[] = [];
    for (const { candidate, tier } of ranked) {
      if (candidate.score < FOOD_SEARCH_FLOOR || seen.has(candidate.foodId)) continue;
      const food = db.byId(candidate.foodId) ?? corpusFood(candidate.foodId);
      if (!food) continue;
      seen.add(candidate.foodId);
      hits.push({
        foodId: food.id,
        name: food.name,
        ...(food.names.tr ? { localizedName: food.names.tr } : {}),
        source: food.source,
        kcalPer100g: food.per100g.kcal,
        score: candidate.score,
        tier,
      });
      if (hits.length === limit) break;
    }
    return hits;
  };

  // Production traffic writes here; the eval deliberately does not, so the
  // ledger stays a record of what real people asked for.
  const gaps = createGapLedger();

  const pipeline = createPipeline({
    db, lexical, vector, aliases, extractor,
    ...(reranker ? { reranker } : {}),
    ...(corpus ? { corpus, corpusFood } : {}),
    ...(gaps.enabled ? { gaps } : {}),
  });

  logger.info(
    {
      extractor: extractor.id, model: extractor.model, vector: vector.available,
      foods: db.all.length,
      corpus: corpusWired ? corpusData.size : 0,
      corpusAutoResolve,
      gaps: gaps.enabled ? gaps.stats().entries : 'off',
    },
    'pipeline ready',
  );

  return buildServer({
    db, pipeline, aliases, vector,
    extractorId: extractor.id,
    supportsVision: extractor.supportsVision,
    foodSearch,
    ...(corpusWired ? { corpusFood, corpusSize: corpusData.size } : {}),
    ...(gaps.enabled ? { gaps } : {}),
  });
}
