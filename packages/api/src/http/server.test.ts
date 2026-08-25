import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadFoodDb } from '../data/foodDb.js';
import { createGapLedger } from '../gaps/ledger.js';
import { buildServer } from './server.js';
import type { MealLog } from '../domain/log.js';
import { createPipeline } from '../pipeline/index.js';
import { withRuleFallback } from '../pipeline/extract/fallback.js';
import { createRuleExtractor } from '../pipeline/extract/rules.js';
import type { Extractor } from '../pipeline/extract/types.js';
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

describe('GET /v1/foods/search', () => {
  it('lets a person find the exact row that corrects one mistaken item', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/foods/search?q=tatl%C4%B1%20patates',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.foods[0]).toMatchObject({
      foodId: 'fdc:168483',
      localizedName: 'Tatlı patates (fırında)',
      tier: 'curated',
    });
    expect(body.foods[0].source).toContain('USDA');
    expect(body.foods[0].kcalPer100g).toBeGreaterThan(0);
  });

  it('requires enough text to return a meaningful correction list', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/foods/search?q=a' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_request');
  });

  it('surfaces common sauces under Turkish and misspelled names', async () => {
    const cases: Array<[string, string]> = [
      ['guacomole', 'fdc:2709307'],
      ['mayonez', 'fdc:2710204'],
      ['ketcap', 'fdc:2709733'],
      ['chımıchurı', 'recipe:chimichurri'],
    ];

    for (const [query, expectedId] of cases) {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/foods/search?q=${encodeURIComponent(query)}`,
      });
      expect(res.statusCode, query).toBe(200);
      expect(res.json().foods[0]?.foodId, query).toBe(expectedId);
    }
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

describe('photos when the vision provider is temporarily unavailable', () => {
  it('returns an actionable 503 instead of a generic internal error', async () => {
    const failingVision: Extractor = {
      id: 'failing-vision',
      model: 'test-model',
      supportsVision: true,
      promptVersion: 'test',
      extract: () => Promise.reject(new Error('429 provider quota exhausted')),
      lastUsage: () => null,
    };
    const extractor = withRuleFallback(failingVision);
    const outageApp = await buildServer({
      db,
      aliases,
      vector,
      extractorId: extractor.id,
      supportsVision: true,
      pipeline: createPipeline({
        db, lexical: buildLexicalIndex(db), vector, aliases, extractor,
      }),
    });

    try {
      const res = await outageApp.inject({
        method: 'POST',
        url: '/v1/meals',
        payload: { imageBase64: 'iVBORw0KGgo=', imageMediaType: 'image/png' },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('vision_temporarily_unavailable');
      expect(res.json().error.message).toMatch(/description|later/i);
    } finally {
      await outageApp.close();
    }
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

  it('turns an unresolved line into a traceable food without re-logging the meal', async () => {
    const meal = (await post({ text: 'bir kase kinoa' }, { 'x-user-id': 'u-unresolved' })).json();
    expect(meal.items).toHaveLength(1);
    expect(meal.items[0].foodId).toBeNull();

    const correction = await app.inject({
      method: 'POST',
      url: `/v1/meals/${meal.id}/corrections`,
      headers: { 'x-user-id': 'u-unresolved' },
      payload: { itemId: meal.items[0].id, foodId: 'fdc:168483' },
    });

    expect(correction.statusCode).toBe(200);
    const corrected = correction.json().log;
    expect(corrected.id).toBe(meal.id);
    expect(corrected.items[0].id).toBe(meal.items[0].id);
    expect(corrected.items[0].foodId).toBe('fdc:168483');
    expect(corrected.items[0].nutrition.likely.kcal).toBeGreaterThan(0);
    expect(corrected.items[0].source).toContain('USDA');
  });
});

/**
 * Correcting the meal you are looking at.
 *
 * The alias tests above are about the NEXT meal. These are about this one: the
 * app used to re-log from the item phrases to see a change, which could not
 * move a stated amount, threw away photographs, and renumbered every item
 * mid-question. See `pipeline/correct.ts`.
 */
describe('corrections applied in place', () => {
  const correct = (mealId: string, payload: Record<string, unknown>, userId = 'u-fix') =>
    app.inject({
      method: 'POST',
      url: `/v1/meals/${mealId}/corrections`,
      headers: { 'x-user-id': userId },
      payload,
    });

  it('moves an amount the user stated in words — the case that used to do nothing', async () => {
    const meal = (await post({ text: '150 g makarna' }, { 'x-user-id': 'u-fix' })).json();
    const item = meal.items[0];
    expect(item.portion.method).toBe('stated_mass');
    expect(item.portion.gramsLikely).toBe(150);

    const res = await correct(meal.id, { itemId: item.id, grams: 220 });
    expect(res.statusCode).toBe(200);

    const updated = res.json().log;
    expect(updated.items[0].portion.gramsLikely).toBe(220);
    expect(updated.items[0].portion.method).toBe('user_set');
    // 220 g x 158 kcal/100g, and the total moves with it.
    expect(updated.items[0].nutrition.likely.kcal).toBeCloseTo(347.6, 1);
    expect(updated.totals.likely.kcal).toBeCloseTo(347.6, 1);
  });

  it('keeps the meal and its item ids, so the app does not lose its place', async () => {
    const meal = (await post({ text: '2 dilim beyaz ekmek' }, { 'x-user-id': 'u-fix' })).json();
    const updated = (await correct(meal.id, { itemId: meal.items[0].id, grams: 90 })).json().log;

    expect(updated.id).toBe(meal.id);
    expect(updated.items[0].id).toBe(meal.items[0].id);
    expect(updated.createdAt).toBe(meal.createdAt);
  });

  it('stores the corrected meal rather than leaving a stale one behind', async () => {
    const meal = (await post({ text: '2 dilim beyaz ekmek' }, { 'x-user-id': 'u-fix' })).json();
    await correct(meal.id, { itemId: meal.items[0].id, grams: 90 });

    const reread = (await app.inject({
      method: 'GET', url: `/v1/meals/${meal.id}`, headers: { 'x-user-id': 'u-fix' },
    })).json();
    expect(reread.items[0].portion.gramsLikely).toBe(90);
  });

  it('re-derives the amount from the words when only the food changed', async () => {
    // "2 dilim" is 56 g of white bread and 64 g of whole-wheat. Carrying the
    // old grams across would apply one food's measure table to another.
    const meal = (await post({ text: '2 dilim ekmek' }, { 'x-user-id': 'u-fix2' })).json();
    expect(meal.items[0].portion.gramsLikely).toBe(56);

    const updated = (await correct(
      meal.id, { itemId: meal.items[0].id, foodId: 'fdc:172688' }, 'u-fix2',
    )).json().log;

    expect(updated.items[0].foodId).toBe('fdc:172688');
    expect(updated.items[0].portion.gramsLikely).toBe(64);
  });

  it('settles the item it answered, so the next question becomes reachable', async () => {
    const meal = (await post({ text: 'biraz peynir' }, { 'x-user-id': 'u-fix3' })).json();
    const asked = meal.questions.filter((q: { itemId: string }) => q.itemId === meal.items[0].id);
    expect(asked.length).toBeGreaterThan(0);

    const updated = (await correct(
      meal.id, { itemId: meal.items[0].id, foodId: 'tr:kasar', grams: 40 }, 'u-fix3',
    )).json().log;

    expect(updated.questions.some((q: { itemId: string }) => q.itemId === updated.items[0].id))
      .toBe(false);
    expect(updated.items[0].confidence.band).toBe('high');
  });

  it('refuses a body that changes neither the food nor the amount', async () => {
    const meal = (await post({ text: '1 elma' }, { 'x-user-id': 'u-fix' })).json();
    const res = await correct(meal.id, { itemId: meal.items[0].id });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_request');
  });

  it('refuses a slipped digit rather than reporting 7,000 kcal of pasta', async () => {
    const meal = (await post({ text: '150 g makarna' }, { 'x-user-id': 'u-fix' })).json();
    const res = await correct(meal.id, { itemId: meal.items[0].id, grams: 20000 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_request');
  });
});

/**
 * Adding a food the meal was logged without.
 *
 * Correction can only reach a line that already exists. A plate read as four
 * items when there were five has no wrong line on it — it has a missing one —
 * and the only repair available for that used to be logging the whole meal a
 * second time, which throws away the photograph, the item ids the app is
 * mid-question about, and every correction already made to it.
 */
describe('POST /v1/meals/:id/items', () => {
  const add = (mealId: string, payload: Record<string, unknown>, userId = 'u-add') =>
    app.inject({
      method: 'POST',
      url: `/v1/meals/${mealId}/items`,
      headers: { 'x-user-id': userId },
      payload,
    });

  it('appends the food and moves the total, leaving the existing line alone', async () => {
    const meal = (await post({ text: '2 dilim beyaz ekmek' }, { 'x-user-id': 'u-add' })).json();
    expect(meal.items).toHaveLength(1);

    const res = await add(meal.id, { foodId: 'fdc:174924', grams: 50, phrase: 'bir dilim daha' });
    expect(res.statusCode).toBe(201);

    const updated = res.json().log;
    expect(updated.id).toBe(meal.id);
    expect(updated.items).toHaveLength(2);
    expect(res.json().itemId).toBe(updated.items[1].id);

    // The line that was already there keeps its id and its number.
    expect(updated.items[0].id).toBe(meal.items[0].id);
    expect(updated.items[0].nutrition.likely.kcal).toBeCloseTo(148.96, 1);

    // 50 g x 266 kcal/100g, the value on USDA FDC 174924.
    expect(updated.items[1].nutrition.likely.kcal).toBeCloseTo(133, 1);
    expect(updated.items[1].portion.method).toBe('user_set');
    expect(updated.items[1].source).toContain('USDA');
    expect(updated.totals.likely.kcal).toBeCloseTo(281.96, 1);
  });

  it('estimates the amount when none was given, rather than refusing to add', async () => {
    const meal = (await post({ text: '1 elma' }, { 'x-user-id': 'u-add' })).json();
    const updated = (await add(meal.id, { foodId: 'fdc:174924' })).json().log;

    const added = updated.items[1];
    expect(added.portion.gramsLikely).toBeGreaterThan(0);
    expect(added.portion.method).not.toBe('user_set');
    expect(added.nutrition.likely.kcal).toBeGreaterThan(0);
  });

  it('stores the extended meal rather than leaving a stale one behind', async () => {
    const meal = (await post({ text: '1 elma' }, { 'x-user-id': 'u-add2' })).json();
    await add(meal.id, { foodId: 'tr:kasar', grams: 30 }, 'u-add2');

    const reread = (await app.inject({
      method: 'GET', url: `/v1/meals/${meal.id}`, headers: { 'x-user-id': 'u-add2' },
    })).json();
    expect(reread.items).toHaveLength(2);
    expect(reread.totals.likely.kcal).toBeGreaterThan(0);
  });

  it('gives an empty log somewhere to go — the case with nothing else to tap', async () => {
    const meal = (await post({ text: 'bir sey yemedim' }, { 'x-user-id': 'u-add3' })).json();
    expect(meal.items).toHaveLength(0);
    expect(meal.totals.likely.kcal).toBe(0);

    const updated = (await add(meal.id, { foodId: 'fdc:174924', grams: 100 }, 'u-add3')).json().log;
    expect(updated.items).toHaveLength(1);
    expect(updated.totals.likely.kcal).toBeCloseTo(266, 1);
    // The "nothing eaten" note stops being true the moment something is added.
    expect(updated.questions.some((q: { itemId: string }) => q.itemId === 'none')).toBe(false);
  });

  it('teaches mise the wording, so the same word resolves itself next time', async () => {
    const meal = (await post({ text: '1 elma' }, { 'x-user-id': 'u-add-alias' })).json();
    await add(meal.id, { foodId: 'fdc:172388', phrase: 'tavuk' }, 'u-add-alias');

    const next = (await post({ text: 'tavuk' }, { 'x-user-id': 'u-add-alias' })).json();
    expect(next.items[0].foodId).toBe('fdc:172388');
    expect(next.items[0].resolution.method).toBe('user_alias');
  });

  it('refuses a food that is not in either tier', async () => {
    const meal = (await post({ text: '1 elma' }, { 'x-user-id': 'u-add' })).json();
    const res = await add(meal.id, { foodId: 'fdc:does-not-exist' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('unknown_food');
  });

  it('404s on a meal that does not exist', async () => {
    const res = await add('no-such-meal', { foodId: 'fdc:174924' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });

  it('refuses a slipped digit rather than logging 7,000 kcal of bread', async () => {
    const meal = (await post({ text: '1 elma' }, { 'x-user-id': 'u-add' })).json();
    const res = await add(meal.id, { foodId: 'fdc:174924', grams: 20000 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_request');
  });
});

/**
 * The gap ledger, end to end.
 *
 * Its own server instance with its own temporary directory: the shared one
 * above deliberately has no ledger, which is also the assertion that the
 * pipeline works without one.
 */
describe('GET /v1/gaps', () => {
  let dir: string;
  let withGaps: FastifyInstance;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mise-gaps-http-'));
    const gaps = createGapLedger({ dir, enabled: true });
    const ledgerAliases = createAliasStore(GLOBAL_ALIAS_SEED);
    withGaps = await buildServer({
      db, vector, gaps,
      aliases: ledgerAliases,
      extractorId: 'rules-v1',
      supportsVision: false,
      pipeline: createPipeline({
        db, lexical: buildLexicalIndex(db), vector, gaps,
        aliases: ledgerAliases,
        extractor: createRuleExtractor(),
      }),
    });
  });

  afterAll(async () => {
    await withGaps.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const log = (text: string, userId = 'g1') =>
    withGaps.inject({
      method: 'POST', url: '/v1/meals', payload: { text, locale: 'tr-TR' },
      headers: { 'x-user-id': userId },
    });

  it('writes down a food it could not name', async () => {
    await log('bir kase kinoa');
    const body = (await withGaps.inject({ method: 'GET', url: '/v1/gaps?kind=unknown_food' })).json();

    expect(body.entries.length).toBeGreaterThan(0);
    expect(body.entries.some((e: { subject: string }) => e.subject.includes('kinoa'))).toBe(true);
  });

  it('writes down a correction with the answer the user gave', async () => {
    const meal = (await log('tavuk', 'g2')).json();
    await withGaps.inject({
      method: 'POST',
      url: `/v1/meals/${meal.id}/corrections`,
      headers: { 'x-user-id': 'g2' },
      payload: { itemId: meal.items[0].id, foodId: 'fdc:172388' },
    });

    const body = (await withGaps.inject({ method: 'GET', url: '/v1/gaps?kind=corrected_food' })).json();
    const entry = body.entries.find((e: { subject: string }) => e.subject === 'tavuk');
    expect(entry.observed).toBe('fdc:171477');
    expect(entry.expected).toBe('fdc:172388');
    expect(entry.candidates.length).toBeGreaterThan(0);
  });

  it('writes down a food it never extracted, with the row the user picked', async () => {
    const meal = (await log('1 elma', 'g3')).json();
    await withGaps.inject({
      method: 'POST',
      url: `/v1/meals/${meal.id}/items`,
      headers: { 'x-user-id': 'g3' },
      payload: { foodId: 'fdc:172388', phrase: 'yanında tavuk' },
    });

    const body = (await withGaps.inject({ method: 'GET', url: '/v1/gaps?kind=missed_item' })).json();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].expected).toBe('fdc:172388');
    expect(body.entries[0].samples).toContain('yanında tavuk');
  });

  it('renders a report and an export from the same data', async () => {
    const text = await withGaps.inject({ method: 'GET', url: '/v1/gaps?format=text' });
    expect(text.headers['content-type']).toContain('text/plain');
    expect(text.body).toContain('WHAT WOULD FIX THEM');

    const jsonl = await withGaps.inject({ method: 'GET', url: '/v1/gaps?format=jsonl' });
    const lines = jsonl.body.trim().split('\n').map((l) => JSON.parse(l) as { kind: string });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => typeof l.kind === 'string')).toBe(true);
  });

  it('rejects a kind that does not exist rather than returning everything', async () => {
    const res = await withGaps.inject({ method: 'GET', url: '/v1/gaps?kind=whatever' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('unknown_kind');
  });

  it('404s on a server that is not collecting', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/gaps' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('gaps_disabled');
  });
});

describe('DELETE /v1/me', () => {
  let dir: string;
  let server: FastifyInstance;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mise-erase-'));
    const gaps = createGapLedger({ dir, enabled: true });
    const eraseAliases = createAliasStore(GLOBAL_ALIAS_SEED);
    server = await buildServer({
      db, vector, gaps,
      aliases: eraseAliases,
      extractorId: 'rules-v1',
      supportsVision: false,
      pipeline: createPipeline({
        db, lexical: buildLexicalIndex(db), vector, gaps,
        aliases: eraseAliases,
        extractor: createRuleExtractor(),
      }),
    });
  });

  afterAll(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const log = (text: string, userId: string, headers: Record<string, string> = {}) =>
    server.inject({
      method: 'POST', url: '/v1/meals', payload: { text, locale: 'tr-TR' },
      headers: { 'x-user-id': userId, ...headers },
    });

  const erase = (userId?: string) =>
    server.inject({
      method: 'DELETE', url: '/v1/me',
      ...(userId !== undefined ? { headers: { 'x-user-id': userId } } : {}),
    });

  const history = async (userId: string) =>
    (await server.inject({ method: 'GET', url: '/v1/meals', headers: { 'x-user-id': userId } }))
      .json().meals as MealLog[];

  it('erases the meals, and reports how many', async () => {
    await log('2 dilim ekmek', 'e-meals');
    await log('bir bardak süt', 'e-meals');
    expect(await history('e-meals')).toHaveLength(2);

    const res = await erase('e-meals');
    expect(res.statusCode).toBe(200);
    expect(res.json().erased.meals).toBe(2);
    expect(await history('e-meals')).toHaveLength(0);
  });

  it('erases the correction, so the phrase resolves as it did before they ever corrected it', async () => {
    const meal = (await log('tavuk', 'e-alias')).json();
    await server.inject({
      method: 'POST',
      url: `/v1/meals/${meal.id}/corrections`,
      headers: { 'x-user-id': 'e-alias' },
      payload: { itemId: meal.items[0].id, foodId: 'fdc:172388' },
    });
    expect((await log('tavuk', 'e-alias')).json().items[0].foodId).toBe('fdc:172388');

    expect((await erase('e-alias')).json().erased.corrections).toBeGreaterThan(0);
    // Back to the curated global default. An alias that outlived the erasure
    // would keep answering in the voice of someone who asked to be forgotten.
    expect((await log('tavuk', 'e-alias')).json().items[0].foodId).toBe('fdc:171477');
  });

  it('erases the cached response, so a replayed key cannot resurrect the meal', async () => {
    const key = { 'idempotency-key': 'erase-replay-1' };
    const first = await log('2 dilim ekmek', 'e-idem', key);
    const replay = await log('2 dilim ekmek', 'e-idem', key);
    expect(replay.json().id).toBe(first.json().id);

    expect((await erase('e-idem')).json().erased.cachedResponses).toBe(1);

    const after = await log('2 dilim ekmek', 'e-idem', key);
    expect(after.headers['idempotent-replay']).toBeUndefined();
    expect(after.json().id).not.toBe(first.json().id);
  });

  it('deletes a gap row only they hit, and keeps one other people hit too', async () => {
    await log('bir kase kinoa', 'e-gap');
    await log('kuskus', 'e-gap');
    await log('kuskus', 'e-other');

    const before = (await server.inject({ method: 'GET', url: '/v1/gaps?kind=unknown_food' })).json();
    const subjects = before.entries.map((e: { subject: string }) => e.subject);
    expect(subjects).toContain('kinoa');
    expect(subjects).toContain('kuskus');

    const body = (await erase('e-gap')).json();
    expect(body.erased.gapRows).toBeGreaterThan(0);
    expect(body.retained.sharedGapRows).toBeGreaterThan(0);

    const after = (await server.inject({ method: 'GET', url: '/v1/gaps?kind=unknown_food' })).json();
    const left = after.entries as Array<{ subject: string; users: number }>;
    // Theirs alone is gone; the shared one stays, with one fewer person behind it.
    expect(left.some((e) => e.subject === 'kinoa')).toBe(false);
    expect(left.find((e) => e.subject === 'kuskus')?.users).toBe(1);
  });

  it('erases one account without touching the next', async () => {
    await log('2 dilim ekmek', 'e-keep');
    await log('2 dilim ekmek', 'e-go');

    await erase('e-go');
    expect(await history('e-keep')).toHaveLength(1);
  });

  it('refuses a request with no user id rather than erasing the anonymous bucket', async () => {
    const res = await erase();
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('user_required');
  });

  it('is idempotent: erasing twice reports nothing left the second time', async () => {
    await log('2 dilim ekmek', 'e-twice');
    expect((await erase('e-twice')).json().erased.meals).toBe(1);
    expect((await erase('e-twice')).json().erased.meals).toBe(0);
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
    expect(body.curatedFoods).toBe(body.foods);
    expect(body.referenceFoods).toBe(0);
    expect(body.searchableFoods).toBe(body.foods);
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
