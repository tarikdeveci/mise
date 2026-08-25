import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadFoodDb } from '../../data/foodDb.js';
import { createGapLedger } from '../../gaps/ledger.js';
import type { ExtractedItem, MealInput } from '../../domain/log.js';
import { createPipeline } from '../index.js';
import { buildLexicalIndex } from '../resolve/lexical.js';
import { createAliasStore, GLOBAL_ALIAS_SEED } from '../resolve/aliasStore.js';
import type { Extractor } from './types.js';
import { mergeModifierCompounds } from './compound.js';

/**
 * The reported failure, in the user's own words: they typed "yumurtalı noodle"
 * meaning noodles with egg in the dough, and got an egg and a bowl of noodles.
 */

const item = (phrase: string, extra: Partial<ExtractedItem> = {}): ExtractedItem => ({
  phrase, preparation: 'unknown', confidence: 0.9, ...extra,
});

/** Stands in for the food database when the test is about the words alone. */
const knows = (...phrases: string[]) =>
  (phrase: string): boolean => phrases.includes(phrase.toLowerCase());

describe('mergeModifierCompounds', () => {
  it('rejoins a compound the extractor split into modifier and head', () => {
    const { items, notes } = mergeModifierCompounds(
      [item('yumurta', { quantity: 1 }), item('noodle', { quantity: 1, unit: 'bowl' })],
      'yumurtalı noodle',
      knows('yumurtalı noodle'),
    );

    expect(items).toHaveLength(1);
    expect(items[0]?.phrase).toBe('yumurtalı noodle');
    // The head carries the amount: a bowl of the dish, not one egg's worth.
    expect(items[0]?.unit).toBe('bowl');
    expect(notes).toHaveLength(1);
  });

  it('leaves the split alone when the compound names no single food', () => {
    // Pasta with mince really is two foods, and counting them apart is the
    // more accurate answer. Morphology alone cannot tell these two cases
    // apart, which is why the database gets the deciding vote.
    const items = [item('kıyma'), item('makarna')];
    const merged = mergeModifierCompounds(items, 'kıymalı makarna', knows('yumurtalı noodle'));

    expect(merged.items).toHaveLength(2);
    expect(merged.notes).toHaveLength(0);
  });

  it('does not swallow a food that was named separately as well', () => {
    const { items } = mergeModifierCompounds(
      [item('yumurta'), item('noodle'), item('yumurta', { quantity: 1 })],
      'yumurtalı noodle ve 1 yumurta',
      knows('yumurtalı noodle'),
    );

    expect(items.map((i) => i.phrase)).toEqual(['yumurtalı noodle', 'yumurta']);
  });

  it('only joins halves the extractor emitted next to each other', () => {
    // Two items apart in the list describe two places in the sentence.
    const { items } = mergeModifierCompounds(
      [item('yumurta'), item('çay'), item('noodle')],
      'yumurtalı noodle',
      knows('yumurtalı noodle'),
    );
    expect(items).toHaveLength(3);
  });

  it('is a no-op for a photo, which has no words to read a compound out of', () => {
    const items = [item('yumurta'), item('noodle')];
    expect(mergeModifierCompounds(items, undefined, knows('yumurtalı noodle')).items).toBe(items);
  });

  it('leaves an extractor that got it right untouched', () => {
    const items = [item('yumurtalı noodle')];
    expect(mergeModifierCompounds(items, 'yumurtalı noodle', knows('yumurtalı noodle')).items)
      .toBe(items);
  });

  it('ignores a three-letter word that merely ends in -li', () => {
    const items = [item('bal'), item('ekmek')];
    expect(mergeModifierCompounds(items, 'bali ekmek', knows('bali ekmek')).items).toHaveLength(2);
  });
});

/**
 * End to end, because the interesting part is the wiring: the merge is only
 * correct if the phrase it produces resolves to the row it claimed existed.
 */
describe('a splitting extractor, through the whole pipeline', () => {
  const db = loadFoodDb();
  const vector = { available: false as const, search: async () => [] };

  const splitter: Extractor = {
    id: 'splitter', model: 'test', supportsVision: false, promptVersion: 'test',
    extract: async (_input: MealInput) => ({
      items: [item('yumurta', { quantity: 1 }), item('noodle')],
      notFood: false,
    }),
  };

  it('logs one bowl of egg noodles, not an egg beside plain noodles', async () => {
    const pipeline = createPipeline({
      db,
      lexical: buildLexicalIndex(db),
      vector,
      aliases: createAliasStore(GLOBAL_ALIAS_SEED),
      extractor: splitter,
    });

    const log = await pipeline.process(
      { text: 'yumurtalı noodle', locale: 'tr-TR' },
      { userId: 'u-compound' },
    );

    expect(log.items).toHaveLength(1);
    expect(log.items[0]?.foodId).toBe('fdc:169732');
    expect(log.items[0]?.foodName).toContain('Noodles');
  });

  /**
   * The merge is a net under the extractor, and a net nobody looks at is how
   * you end up shipping the model that keeps falling into it. Every rejoin is
   * a labelled training example — the text, and the single item it should have
   * produced — so it goes in the ledger as one.
   */
  it('files the rejoin as a training example rather than silently fixing it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mise-compound-'));
    try {
      const gaps = createGapLedger({ dir, enabled: true });
      const pipeline = createPipeline({
        db,
        lexical: buildLexicalIndex(db),
        vector,
        aliases: createAliasStore(GLOBAL_ALIAS_SEED),
        extractor: splitter,
        gaps,
      });

      await pipeline.process({ text: 'yumurtalı noodle', locale: 'tr-TR' }, { userId: 'u-compound' });

      const [entry] = gaps.entries({ kind: 'split_compound' });
      expect(entry).toBeDefined();
      // Both halves and the phrase they should have been, in the row itself.
      expect(entry?.note).toContain('yumurta');
      expect(entry?.note).toContain('yumurtalı noodle');
      expect(entry?.samples).toContain('yumurtalı noodle');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
