import { describe, it, expect } from 'vitest';
import { loadFoodDb } from '../../data/foodDb.js';
import type { ExtractedItem } from '../../domain/log.js';
import { createAliasStore, GLOBAL_ALIAS_SEED } from './aliasStore.js';
import { buildLexicalIndex } from './lexical.js';
import { resolvePhrase } from './router.js';

const db = loadFoodDb();
const deps = {
  db,
  lexical: buildLexicalIndex(db),
  vector: { available: false as const, reason: 'stubbed', search: async () => [] },
  aliases: createAliasStore(GLOBAL_ALIAS_SEED),
};

const resolve = (phrase: string, preparation: ExtractedItem['preparation'] = 'unknown') =>
  resolvePhrase(deps, phrase, { userId: 'test', preparation });

describe('preparation-aware resolution', () => {
  /**
   * Regression for a bug the model bake-off exposed.
   *
   * A well-behaved extractor lifts preparation out of the phrase into its own
   * field, so the router receives "yumurta" where the user wrote "haşlanmış
   * yumurta". Before this fix the router only saw the phrase, the alias
   * fast-path fired, and boiled egg resolved to raw egg. The rule tier hid the
   * bug entirely, because it leaves the preparation word in the phrase.
   */
  it('uses the extracted preparation when the phrase no longer carries it', async () => {
    expect((await resolve('yumurta', 'boiled')).foodId).toBe('fdc:173424');
    expect((await resolve('yumurta', 'fried')).foodId).toBe('fdc:172183');
    expect((await resolve('yumurta', 'raw')).foodId).toBe('fdc:171287');
  });

  it('separates raw from cooked rice, the largest state-driven error in the DB', async () => {
    // 365 vs 130 kcal/100g.
    expect((await resolve('pirinç', 'raw')).foodId).toBe('fdc:169708');
    expect((await resolve('pirinç', 'boiled')).foodId).toBe('fdc:169756');
  });

  it('separates fried from grilled chicken', async () => {
    expect((await resolve('chicken', 'fried')).foodId).toBe('fdc:171123');
    expect((await resolve('chicken', 'grilled')).foodId).toBe('fdc:171477');
  });

  it('keeps the curated default when no preparation is stated', async () => {
    expect((await resolve('yumurta')).foodId).toBe('fdc:171287');
    expect((await resolve('patates')).foodId).toBe('fdc:170026');
  });

  it('does not disturb foods that have no meaningful cooking state', async () => {
    // Olive oil and tea are `n/a`; a stated preparation is neither evidence
    // for nor against them, and must not push them down the list.
    expect((await resolve('zeytinyağı', 'fried')).foodId).toBe('fdc:171413');
    expect((await resolve('çay', 'boiled')).foodId).toBe('fdc:173175');
  });

  it('treats generic "cooked" as compatible with any specific method', async () => {
    const cooked = await resolve('pirinç', 'cooked');
    expect(cooked.foodId).toBe('fdc:169756');
    expect(cooked.foodId).not.toBe('fdc:169708');
  });

  it('still resolves deterministically — same input, same answer', async () => {
    const runs = await Promise.all([
      resolve('yumurta', 'boiled'),
      resolve('yumurta', 'boiled'),
      resolve('yumurta', 'boiled'),
    ]);
    expect(new Set(runs.map((r) => r.foodId)).size).toBe(1);
  });
});
