import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadFoodDb } from '../data/foodDb.js';
import { buildServer } from './server.js';
import type { MealLog } from '../domain/log.js';
import { createPipeline } from '../pipeline/index.js';
import { createRuleExtractor } from '../pipeline/extract/rules.js';
import { createAliasStore, GLOBAL_ALIAS_SEED } from '../pipeline/resolve/aliasStore.js';
import { buildLexicalIndex } from '../pipeline/resolve/lexical.js';

const db = loadFoodDb();
const aliases = createAliasStore(GLOBAL_ALIAS_SEED);
// Vector retrieval is exercised in the eval; the HTTP contract does not depend
// on it, and stubbing keeps this suite offline and fast.
const vector = { available: false as const, reason: 'stubbed in tests', search: async () => [] };

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer({
    db,
    aliases,
    vector,
    extractorId: 'rules-v1',
    supportsVision: false,
    pipeline: createPipeline({
      db, lexical: buildLexicalIndex(db), vector, aliases, extractor: createRuleExtractor(),
    }),
  });
});

afterAll(async () => { await app.close(); });

interface MealPayload {
  barcode?: string;
  text?: string;
  locale?: string;
  imageBase64?: string;
  imageMediaType?: string;
}

// Fastify's `inject` is heavily overloaded; an `unknown` payload makes overload
// resolution fall back to a union that has no `.json()`. Typing it concretely
// keeps `npm run typecheck` meaningful over the test files too.
const post = (payload: MealPayload, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/v1/meals', payload, headers: { 'x-user-id': 'u1', ...headers } });

describe('POST /v1/meals', () => {
  it('logs a meal and returns traceable nutrition', async () => {
    const res = await post({ text: '2 dilim beyaz ekmek', locale: 'tr-TR' });
    expect(res.statusCode).toBe(201);

    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].foodId).toBe('fdc:174924');
    // 56 g x 266 kcal/100g, the value on USDA FDC 174924
    expect(body.items[0].nutrition.likely.kcal).toBeCloseTo(148.96, 1);
    expect(body.items[0].source).toContain('USDA');
    expect(body.provenance.pipelineVersion).toBeTruthy();
  });

  it('rejects a body with neither text nor image', async () => {
    const res = await post({ locale: 'tr-TR' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_request');
  });

  it('always returns an ordered nutrition interval, never a bare number', async () => {
    const body = (await post({ text: 'bir avuç badem', locale: 'tr-TR' })).json();
    const { min, likely, max } = body.totals;
    expect(min.kcal).toBeLessThan(likely.kcal);
    expect(likely.kcal).toBeLessThan(max.kcal);
  });
});

describe('photos when the extractor is text-only', () => {
  it('refuses loudly instead of returning a confirmed, empty, zero-calorie log', async () => {
    // The old behaviour was the worst possible answer: status "confirmed",
    // 0 kcal, no items — the system reporting certainty it never had, because
    // it had not looked at the photo at all.
    const res = await post({ imageBase64: 'iVBORw0KGgo=', locale: 'tr-TR' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('vision_unavailable');
    expect(res.json().error.message).toMatch(/cannot read photos/i);
  });

  it('advertises the limitation on /healthz so the app can hide the camera', async () => {
    const body = (await app.inject({ method: 'GET', url: '/healthz' })).json();
    expect(body.visionAvailable).toBe(false);
  });
});

describe('idempotency', () => {
  it('replays the same log for a repeated key instead of double-logging', async () => {
    const payload = { text: '1 muz', locale: 'tr-TR' };
    const first = await post(payload, { 'idempotency-key': 'key-abc' });
    const second = await post(payload, { 'idempotency-key': 'key-abc' });

    expect(first.statusCode).toBe(201);
    expect((second.headers as Record<string, string>)['idempotent-replay']).toBe('true');
    expect(second.json().id).toBe(first.json().id);
  });

  it('409s when a key is reused with a different body — a client bug, surfaced', async () => {
    await post({ text: '1 elma', locale: 'tr-TR' }, { 'idempotency-key': 'key-xyz' });
    const conflict = await post({ text: '2 elma', locale: 'tr-TR' }, { 'idempotency-key': 'key-xyz' });

    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('idempotency_key_reused');
  });

  it('treats logs without a key as independent events', async () => {
    const payload = { text: '1 portakal', locale: 'tr-TR' };
    const a = await post(payload);
    const b = await post(payload);
    expect(a.json().id).not.toBe(b.json().id);
  });
});

describe('determinism', () => {
  it('returns identical nutrition for the same input every time', async () => {
    const payload = { text: 'menemen ve çay', locale: 'tr-TR' };
    const runs = await Promise.all([post(payload), post(payload), post(payload)]);
    const kcals = runs.map((r) => r.json().totals.likely.kcal);
    // Re-scanning the same meal returning a different calorie count is a
    // documented failure of shipped competitors. It is not a failure we can
    // have: rungs 1-4 of the resolver are pure functions.
    expect(new Set(kcals).size).toBe(1);
  });
});

describe('corrections', () => {
  it('remembers a correction and replays it deterministically next time', async () => {
    const first = (await post({ text: 'tavuk', locale: 'tr-TR' }, { 'x-user-id': 'u2' })).json();
    const item = first.items[0];
    expect(item.foodId).toBe('fdc:171477'); // grilled breast, the curated default

    const correction = await app.inject({
      method: 'POST',
      url: `/v1/meals/${first.id}/corrections`,
      headers: { 'x-user-id': 'u2' },
      payload: { itemId: item.id, foodId: 'fdc:172388' }, // this person means thigh
    });
    expect(correction.statusCode).toBe(200);

    const second = (await post({ text: 'tavuk', locale: 'tr-TR' }, { 'x-user-id': 'u2' })).json();
    expect(second.items[0].foodId).toBe('fdc:172388');
    expect(second.items[0].resolution.method).toBe('user_alias');
  });

  it('does not leak one user\'s correction to another user', async () => {
    const other = (await post({ text: 'tavuk', locale: 'tr-TR' }, { 'x-user-id': 'u3' })).json();
    expect(other.items[0].foodId).toBe('fdc:171477');
  });

  it('refuses a correction pointing at a food that does not exist', async () => {
    const meal = (await post({ text: '1 muz', locale: 'tr-TR' })).json();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/meals/${meal.id}/corrections`,
      headers: { 'x-user-id': 'u1' },
      payload: { itemId: meal.items[0].id, foodId: 'fdc:does-not-exist' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('unknown_food');
  });
});

describe('GET /v1/meals/:id/trace', () => {
  it('shows the arithmetic behind every displayed number', async () => {
    const meal = (await post({ text: '2 dilim beyaz ekmek', locale: 'tr-TR' })).json();
    const trace = (await app.inject({ method: 'GET', url: `/v1/meals/${meal.id}/trace` })).json();

    expect(trace.items[0].arithmetic).toMatch(/266 kcal\/100g x 56 g \/ 100 = 148\.96 kcal/);
    expect(trace.items[0].source).toContain('USDA');
    expect(trace.items[0].resolution.method).toBeTruthy();
  });

  it('404s for an unknown meal', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/meals/nope/trace' });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /healthz', () => {
  it('reports what the pipeline is actually running', async () => {
    const body = (await app.inject({ method: 'GET', url: '/healthz' })).json();
    expect(body.status).toBe('ok');
    expect(body.foods).toBeGreaterThan(50);
  });
});

/**
 * The barcode path.
 *
 * The app presents this as its most accurate entry point, at +/-0%, and it is
 * the only route through the system with no model anywhere in it: the code
 * identifies the product and the label states the nutrition. That makes it both
 * the strongest claim the product makes and, until these tests, the only major
 * path with nothing asserting it.
 *
 * Open Food Facts is stubbed here. The adapter's own validation is covered in
 * `data/openFoodFacts.test.ts`; what matters at this layer is that a scan
 * produces a traceable log without consulting a model, and that a barcode
 * nobody recognises fails as a 404 rather than as a guess.
 */
describe('barcode logging', () => {
  const PRODUCT = {
    product_name: 'Digestive Biscuits',
    brands: 'Ulker',
    serving_quantity: 30,
    nutriments: { 'energy-kcal_100g': 250, proteins_100g: 6.2, carbohydrates_100g: 62, fat_100g: 20.5 },
  };

  const stubOff = (payload: unknown, ok = true): void => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok, status: ok ? 200 : 404, json: async () => payload,
    }) as Response));
  };

  afterEach(() => { vi.unstubAllGlobals(); });

  it('logs a scanned product with the label as its source', async () => {
    stubOff({ status: 1, product: PRODUCT });

    const res = await post({ barcode: '8690504016830' });
    expect(res.statusCode).toBe(201);

    const log = res.json() as MealLog;
    const item = log.items[0];

    expect(item?.foodId).toBe('off:8690504016830');
    expect(item?.source).toBe('Open Food Facts, barcode 8690504016830');
    // 30 g serving at 250 kcal/100 g.
    expect(item?.nutrition?.likely.kcal).toBeCloseTo(75, 0);
  });

  it('uses the label serving rather than estimating a portion', async () => {
    stubOff({ status: 1, product: PRODUCT });

    const log = (await post({ barcode: '8690504016830' })).json() as MealLog;
    const portion = log.items[0]?.portion;

    expect(portion?.method).toBe('barcode_label');
    expect(portion?.gramsLikely).toBe(30);
    // Not a collapsed interval, and deliberately so. The printed serving is an
    // exact number, but "one serving" is still an assumption about what the
    // person ate, and declared nutrients carry labelling tolerance. This is the
    // tightest band the ladder ever produces, and it is not zero — the app used
    // to advertise it as +/-0%, which was the app overclaiming, not the pipeline
    // being timid.
    expect(portion?.gramsMin).toBeCloseTo(27.6, 1);
    expect(portion?.gramsMax).toBeCloseTo(32.4, 1);
  });

  it('needs no model and no question — it auto-logs', async () => {
    stubOff({ status: 1, product: PRODUCT });

    const log = (await post({ barcode: '8690504016830' })).json() as MealLog;

    expect(log.status).toBe('confirmed');
    expect(log.questions).toHaveLength(0);
    expect(log.items[0]?.resolution.method).toBe('barcode');
    // Identification is certain; the portion is very good but not perfect, so
    // overall lands just under 1 rather than at it.
    expect(log.items[0]?.confidence.overall).toBeGreaterThan(0.95);
    expect(log.items[0]?.confidence.overall).toBeLessThan(1);
  });

  it('404s an unknown barcode instead of logging something plausible', async () => {
    stubOff({ status: 0 });

    const res = await post({ barcode: '0000000000000' });

    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe('barcode_not_found');
  });

  it('tells the user what to do instead when the scan fails', async () => {
    stubOff({ status: 0 });

    const body = (await post({ barcode: '0000000000000' })).json() as { error: { message: string } };
    // A dead end with no exit is a worse failure than the lookup itself.
    expect(body.error.message).toMatch(/photo|describ/i);
  });

  it('previews a product without logging it, so the user can confirm first', async () => {
    stubOff({ status: 1, product: PRODUCT });

    const res = await app.inject({
      method: 'GET', url: '/v1/barcode/8690504016830', headers: { 'x-user-id': 'u1' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      barcode: '8690504016830',
      servingGrams: 30,
      source: 'Open Food Facts, barcode 8690504016830',
    });
  });

  it('accepts a body carrying only a barcode — no text, no image', async () => {
    stubOff({ status: 1, product: PRODUCT });
    // The request validator requires one of text/image/barcode; this asserts
    // barcode genuinely counts, which is what makes the scan screen work.
    expect((await post({ barcode: '8690504016830' })).statusCode).toBe(201);
  });
});
