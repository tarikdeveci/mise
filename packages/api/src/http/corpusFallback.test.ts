import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadFoodCorpus } from '../data/corpus.js';
import { loadFoodDb } from '../data/foodDb.js';
import { createPipeline } from '../pipeline/index.js';
import { createRuleExtractor } from '../pipeline/extract/rules.js';
import { createAliasStore, GLOBAL_ALIAS_SEED } from '../pipeline/resolve/aliasStore.js';
import { buildLexicalIndex } from '../pipeline/resolve/lexical.js';
import { buildServer } from './server.js';

/**
 * The LIFEOS-style fallback, without LIFEOS's unsafe part.
 *
 * There is deliberately no reranker in this server. The wide reference corpus
 * may offer choices, but it may not create nutrition until the user chooses a
 * real row. That one tap is then remembered as a user-scoped alias.
 */
describe('reference corpus fallback without a model verifier', () => {
  const db = loadFoodDb();
  const corpusData = loadFoodCorpus(new Set(db.all.map((food) => food.id)));
  const corpus = buildLexicalIndex({
    surfaces: corpusData.surfaces,
    byId: (id) => corpusData.get(id),
  });
  const aliases = createAliasStore(GLOBAL_ALIAS_SEED);
  const vector = { available: false as const, reason: 'stubbed', search: async () => [] };
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer({
      db,
      aliases,
      vector,
      extractorId: 'rules-v1',
      supportsVision: false,
      corpusFood: (id) => corpusData.get(id),
      corpusSize: corpusData.size,
      pipeline: createPipeline({
        db,
        lexical: buildLexicalIndex(db),
        vector,
        aliases,
        extractor: createRuleExtractor(),
        corpus,
        corpusFood: (id) => corpusData.get(id),
      }),
    });
  });

  afterAll(async () => { await app.close(); });

  it('offers wide-corpus foods but leaves calories blank until the user picks one', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/meals',
      headers: { 'x-user-id': 'corpus-user' },
      payload: { text: 'quinoa', locale: 'en-US' },
    });
    const log = response.json();

    expect(response.statusCode).toBe(201);
    expect(log.items[0].foodId).toBeNull();
    expect(log.totals.likely.kcal).toBe(0);
    expect(log.questions[0].options[0]).toMatchObject({
      label: expect.stringMatching(/quinoa/i),
      foodId: 'fdc:168917',
    });
  });

  it('turns a user choice into traceable nutrition and remembers it', async () => {
    const first = (await app.inject({
      method: 'POST',
      url: '/v1/meals',
      headers: { 'x-user-id': 'corpus-learner' },
      payload: { text: 'quinoa', locale: 'en-US' },
    })).json();

    const correction = await app.inject({
      method: 'POST',
      url: `/v1/meals/${first.id}/corrections`,
      headers: { 'x-user-id': 'corpus-learner' },
      payload: { itemId: first.items[0].id, foodId: 'fdc:168917', grams: 185 },
    });
    const corrected = correction.json().log;

    expect(correction.statusCode).toBe(200);
    expect(corrected.items[0].source).toContain('USDA FDC 168917');
    expect(corrected.items[0].nutrition.likely.kcal).toBeGreaterThan(0);

    const trace = (await app.inject({
      method: 'GET',
      url: `/v1/meals/${first.id}/trace`,
    })).json();
    expect(trace.items[0].source).toContain('USDA FDC 168917');
    expect(trace.items[0].arithmetic).toContain('185 g / 100');

    const replay = (await app.inject({
      method: 'POST',
      url: '/v1/meals',
      headers: { 'x-user-id': 'corpus-learner' },
      payload: { text: 'quinoa', locale: 'en-US' },
    })).json();
    expect(replay.items[0]).toMatchObject({
      foodId: 'fdc:168917',
      source: expect.stringContaining('USDA FDC 168917'),
      resolution: { method: 'user_alias' },
    });
  });

  it('reports both confidence tiers instead of looking like an 87-food database', async () => {
    const health = (await app.inject({ method: 'GET', url: '/healthz' })).json();
    expect(health.curatedFoods).toBe(db.all.length);
    expect(health.referenceFoods).toBe(corpusData.size);
    expect(health.searchableFoods).toBe(db.all.length + corpusData.size);
    expect(health.foods).toBe(health.searchableFoods);
  });
});
