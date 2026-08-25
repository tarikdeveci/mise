import { describe, it, expect } from 'vitest';
import { loadFoodCorpus } from './corpus.js';
import { loadFoodDb } from './foodDb.js';
import { buildLexicalIndex } from '../pipeline/resolve/lexical.js';
import { createAliasStore, GLOBAL_ALIAS_SEED } from '../pipeline/resolve/aliasStore.js';
import { resolvePhrase } from '../pipeline/resolve/router.js';

/**
 * The second tier, and the reason it is gated.
 *
 * Widening from 87 curated rows to 13k+ USDA rows is the single biggest
 * coverage win available, and also the single easiest way to start returning
 * confident nonsense. Measured on this corpus, plain retrieval answers "iced
 * tea" with beef sandwich steaks and "grapes" with grapeseed oil — both around
 * ten times the real energy, both perfectly plausible-looking in a log.
 *
 * So these tests are less about the corpus finding things and more about what
 * it refuses to auto-accept without supervision.
 */

const db = loadFoodDb();
const seedIds = new Set(db.all.map((f) => f.id));
const corpusData = loadFoodCorpus(seedIds);
const corpus = buildLexicalIndex({
  surfaces: corpusData.surfaces,
  byId: (id) => corpusData.get(id),
});

const base = {
  db,
  lexical: buildLexicalIndex(db),
  vector: { available: false as const, reason: 'stubbed', search: async () => [] },
  aliases: createAliasStore(GLOBAL_ALIAS_SEED),
};

/** A verifier that endorses whatever it is shown. Stands in for a good model. */
const agreeable = {
  id: 'fake',
  choose: async ({ candidates }: { candidates: Array<{ foodId: string }> }) =>
    ({ foodId: candidates[0]?.foodId ?? null, confidence: 0.8 }),
};

const refusing = { id: 'fake', choose: async () => ({ foodId: null, confidence: 0 }) };

describe('the corpus', () => {
  it('is built, and is far larger than the curated set', () => {
    expect(corpusData.available).toBe(true);
    expect(corpusData.size).toBeGreaterThan(7000);
    expect(corpusData.size).toBeGreaterThan(db.all.length * 50);
  });

  it('hides every food the curated tier already covers', () => {
    // Two rows for one food would split retrieval between them and let the
    // uncurated copy — no aliases, no Turkish, no real measures — win by chance.
    for (const id of seedIds) {
      if (id.startsWith('fdc:')) expect(corpusData.get(id)).toBeUndefined();
    }
  });

  it('materialises a row into a food with its citation intact', () => {
    const food = corpusData.get('fdc:168917');           // Quinoa, cooked
    expect(food?.name).toMatch(/quinoa/i);
    // The id is the checkable part; the set name says what kind of evidence it
    // is, which matters now that one corpus is built from three of them.
    expect(food?.source).toContain('USDA FDC 168917');
    expect(food?.source).toContain('SR Legacy');
    expect(food?.per100g.kcal).toBeGreaterThan(0);
  });

  it('carries dishes, not only ingredients — the reason FNDDS is in here', () => {
    // "guacamole" is the case that exposed the hole: SR Legacy has four
    // avocado rows and no guacamole, so a real plate fell through to a
    // question the user could not answer either.
    const dishes = corpusData.surfaces.filter((s) => s.text.includes('guacamole'));
    expect(dishes.length).toBeGreaterThan(0);

    const food = corpusData.get(dishes[0]!.foodId);
    expect(food?.source).toContain('FNDDS');
    expect(food?.per100g.kcal).toBeGreaterThan(50);
  });

  it('gives every row a measure, so the portion ladder always has a rung', () => {
    for (const id of ['fdc:168917', 'fdc:174915', 'fdc:168411']) {
      expect(corpusData.get(id)?.measures.length).toBeGreaterThan(0);
    }
  });

  it('marks corpus rows as unclassified rather than guessing a cooking state', () => {
    // A guessed `state` would let an uncurated row win a preparation boost it
    // has not earned, and outrank a curated row that stated its state honestly.
    const food = corpusData.get('fdc:168917');
    expect(food?.state).toBe('n/a');
  });
});

describe('the corpus rung', () => {
  it('finds a food the curated set does not have', async () => {
    const r = await resolvePhrase(
      { ...base, corpus, reranker: agreeable }, 'quinoa', { userId: 'test' },
    );
    expect(r.method).toBe('corpus');
    expect(r.foodId).toMatch(/^fdc:\d+$/);
  });

  /**
   * The property that makes the whole tier safe to ship.
   */
  it('offers candidates without a verifier but does not turn them into calories', async () => {
    const r = await resolvePhrase({ ...base, corpus }, 'quinoa', { userId: 'test' });

    // Not "fall back to the best corpus score". Retrieval alone over thousands
    // of rows is exactly the thing that produces "iced tea" -> beef. The user
    // may choose from the shortlist, but no row is accepted before that tap.
    expect(r.foodId).toBeNull();
    expect(r.method).toBe('unresolved');
    expect(r.candidates[0]?.name).toMatch(/quinoa/i);
    expect(r.candidates[0]?.score).toBeGreaterThan(0.72);
  });

  it('bridges common Turkish spellings into the English USDA shortlist', async () => {
    const cases = [
      ['kinoa', /quinoa/i],
      ['kuskus', /couscous/i],
      ['suşi', /sushi/i],
      ['pad tay', /pad thai/i],
      ['lazanya', /lasagna/i],
    ] as const;

    for (const [phrase, expected] of cases) {
      const r = await resolvePhrase({ ...base, corpus }, phrase, { userId: 'test' });
      expect(r.foodId).toBeNull();
      expect(r.candidates[0]?.name).toMatch(expected);
    }
  });

  it('leaves the item unknown when the verifier rejects the corpus shortlist', async () => {
    const r = await resolvePhrase(
      { ...base, corpus, reranker: refusing }, 'quinoa', { userId: 'test' },
    );
    expect(r.foodId).toBeNull();
    expect(r.candidates[0]?.name).toMatch(/quinoa/i);
  });

  it('drops a verifier answer that was not on the corpus shortlist', async () => {
    const smuggling = { id: 'fake', choose: async () => ({ foodId: 'fdc:999999', confidence: 1 }) };
    const r = await resolvePhrase(
      { ...base, corpus, reranker: smuggling }, 'quinoa', { userId: 'test' },
    );
    expect(r.foodId).toBeNull();
    expect(r.candidates.some((candidate) => candidate.foodId === 'fdc:999999')).toBe(false);
    expect(r.candidates[0]?.name).toMatch(/quinoa/i);
  });

  it('keeps the shortlist available when the verifier is down', async () => {
    const unavailable = {
      id: 'fake',
      choose: async () => { throw new Error('provider unavailable'); },
    };
    const r = await resolvePhrase(
      { ...base, corpus, reranker: unavailable }, 'quinoa', { userId: 'test' },
    );
    expect(r.foodId).toBeNull();
    expect(r.candidates[0]?.name).toMatch(/quinoa/i);
  });

  it('never reaches the corpus for a food the curated set knows', async () => {
    let asked = 0;
    const counting = {
      id: 'fake',
      choose: async () => { asked++; return { foodId: null, confidence: 0 }; },
    };
    const r = await resolvePhrase(
      { ...base, corpus, reranker: counting }, 'yumurta', { userId: 'test' },
    );

    // The curated tier answered on rung 2. Paying for a model *and* searching
    // 13k+ rows to confirm that would be the opposite of the design.
    expect(r.method).toBe('global_alias');
    expect(asked).toBe(0);
  });
});
