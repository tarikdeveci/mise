import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import { loadFoodDb, type FoodDb } from '../data/foodDb.js';
import { MealInput, type MealLog } from '../domain/log.js';
import { logger } from '../obs/logger.js';
import { metrics } from '../obs/metrics.js';
import { createPipeline, PIPELINE_VERSION, type Pipeline } from '../pipeline/index.js';
import {
  createExtractor, availableExtractors, bestAvailableExtractor, isExtractorId,
} from '../pipeline/extract/registry.js';
import { withRuleFallback } from '../pipeline/extract/fallback.js';
import { createAliasStore, GLOBAL_ALIAS_SEED, type AliasStore } from '../pipeline/resolve/aliasStore.js';
import { buildLexicalIndex } from '../pipeline/resolve/lexical.js';
import { createGeminiReranker } from '../pipeline/resolve/reranker.js';
import { buildVectorIndex, type VectorIndex } from '../pipeline/resolve/vector.js';
import { createIdempotencyStore, IdempotencyConflict } from './idempotency.js';
import { lookupBarcode, BarcodeNotFound } from '../data/openFoodFacts.js';

/**
 * HTTP surface.
 *
 * Deliberately small: five endpoints, one of which exists purely so that any
 * number the app shows can be traced back to the database row it came from.
 */

const CreateMealBody = MealInput;

const CorrectionBody = z.object({
  itemId: z.string().min(1),
  /** The food the user actually meant. Must exist — we never store a free-text guess. */
  foodId: z.string().min(1),
  /** Optional corrected mass. "My usual" is a portion, not only a food. */
  grams: z.number().positive().optional(),
});

/** Meal logs, kept in memory. A real deployment swaps this for Postgres. */
interface MealStore {
  put(log: MealLog, userId: string): void;
  get(id: string): { log: MealLog; userId: string } | undefined;
  list(userId: string, limit: number): MealLog[];
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

  /** Device-scoped identity. Real auth is out of scope; see README. */
  const userIdOf = (headers: Record<string, unknown>): string =>
    String(headers['x-user-id'] ?? 'anonymous');

  app.addHook('onRequest', async (req) => {
    req.log = logger.child({ reqId: req.id, route: req.url }) as never;
  });

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
    // The app reads this to decide whether to offer the camera at all. An
    // affordance that silently does nothing is worse than one that is absent.
    visionAvailable: deps.supportsVision,
    vectorRetrieval: deps.vector.available,
    foods: deps.db.all.length,
    extractorsAvailable: availableExtractors(),
  }));

  app.get('/metrics', async () => metrics.snapshot());

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

    if (typeof key === 'string' && key.length > 0) idempotency.put(key, req.body, log);

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
   * Records a user correction.
   *
   * This is the endpoint that makes accuracy improve with use: the correction
   * is stored as a deterministic alias, so the same phrase from the same user
   * resolves instantly and identically next time, with no model call at all.
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

    // Refuse to remember a correction pointing at a food that does not exist —
    // a poisoned alias is worse than no alias, because it is silent and fast.
    const food = deps.db.byId(body.foodId);
    if (!food) {
      return reply.status(400).send({
        error: { code: 'unknown_food', message: `${body.foodId} is not in the food database.`, traceId: String(req.id) },
      });
    }

    const entry = deps.aliases.record(userId, item.extracted.phrase, body.foodId, body.grams);
    metrics.inc('correction_total', { weakestStage: item.confidence.weakest });

    logger.info(
      { mealId: id, itemId: body.itemId, from: item.foodId, to: body.foodId, hits: entry.hits },
      'correction recorded',
    );

    return { recorded: true, phrase: item.extracted.phrase, foodId: body.foodId, hits: entry.hits };
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
        const food = item.foodId ? deps.db.byId(item.foodId) : undefined;
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
  const pipeline = createPipeline({
    db, lexical, vector, aliases, extractor,
    ...(reranker ? { reranker } : {}),
  });

  logger.info(
    { extractor: extractor.id, model: extractor.model, vector: vector.available, foods: db.all.length },
    'pipeline ready',
  );

  return buildServer({
    db, pipeline, aliases, vector,
    extractorId: extractor.id,
    supportsVision: extractor.supportsVision,
  });
}
