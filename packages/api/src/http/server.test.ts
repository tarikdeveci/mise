import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadFoodDb } from '../data/foodDb.js';
import { buildServer } from './server.js';
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
    pipeline: createPipeline({
      db, lexical: buildLexicalIndex(db), vector, aliases, extractor: createRuleExtractor(),
    }),
  });
});

afterAll(async () => { await app.close(); });

interface MealPayload {
  text?: string;
  locale?: string;
  imageBase64?: string;
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
    expect(body.items[0].foodId).toBe('fdc:172687');
    // 56 g x 265 kcal/100g
    expect(body.items[0].nutrition.likely.kcal).toBeCloseTo(148.4, 1);
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
      payload: { itemId: item.id, foodId: 'fdc:171479' }, // this person means thigh
    });
    expect(correction.statusCode).toBe(200);

    const second = (await post({ text: 'tavuk', locale: 'tr-TR' }, { 'x-user-id': 'u2' })).json();
    expect(second.items[0].foodId).toBe('fdc:171479');
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

    expect(trace.items[0].arithmetic).toMatch(/265 kcal\/100g x 56 g \/ 100 = 148\.4 kcal/);
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
