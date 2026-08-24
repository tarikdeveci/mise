import { describe, it, expect } from 'vitest';
import { loadFoodDb } from '../../data/foodDb.js';
import { buildLexicalIndex, MIN_RESOLVABLE_SCORE } from './lexical.js';

const db = loadFoodDb();
const idx = buildLexicalIndex(db);

const top = (q: string) => idx.search(q)[0]?.foodId;
const margin = (q: string) => {
  const r = idx.search(q);
  return (r[0]?.score ?? 0) - (r[1]?.score ?? 0);
};

describe('lexical retrieval', () => {
  it('nails exact names and aliases with a decisive margin', () => {
    expect(top('olive oil')).toBe('fdc:171413');
    expect(top('zeytinyağı')).toBe('fdc:171413');
    expect(margin('zeytinyağı')).toBeGreaterThan(0.3);
  });

  it('separates the preparation-state pairs', () => {
    expect(top('french fries')).toBe('fdc:170032');
    expect(top('haşlanmış patates')).toBe('fdc:170026');
    expect(top('fried chicken')).toBe('fdc:171123');
    expect(top('çiğ pirinç')).toBe('fdc:169708');
  });

  it('separates the brand/variant pairs', () => {
    expect(top('diet coke')).toBe('fdc:175041');
    expect(top('greek yogurt')).toBe('fdc:330137');
  });

  it('handles Turkish morphology via trigrams', () => {
    // "ekmeği" is the possessive form; no alias lists it verbatim.
    expect(top('tam buğday ekmeği')).toBe('fdc:172686');
    expect(top('kaşar peyniri')).toBe('tr:kasar');
  });

  it('surfaces the right food even when the head noun is generic', () => {
    expect(top('tavuk göğsü')).toBe('fdc:171477');
    expect(top('tavuk but')).toBe('fdc:171479');
  });

  it('reports a SMALL margin on genuinely ambiguous input — this is the escalation signal', () => {
    // Bare "yogurt" legitimately matches three rows. The router must see that.
    expect(margin('yogurt')).toBeLessThan(0.3);
  });

  it('keeps non-food input far below the resolution bar', () => {
    // "laptop" really is ~0.11 similar to "latte". Ranking that is correct;
    // resolving it is not. The retriever's contract is only that nothing
    // spurious ever crosses MIN_RESOLVABLE_SCORE.
    const hits = idx.search('laptop');
    expect(hits.every((h) => h.score < MIN_RESOLVABLE_SCORE)).toBe(true);
  });

  it('puts every genuine food comfortably above the bar', () => {
    for (const q of ['olive oil', 'zeytinyağı', 'french fries', 'diet coke', 'kaşar peyniri']) {
      expect(idx.search(q)[0]!.score, q).toBeGreaterThan(MIN_RESOLVABLE_SCORE);
    }
  });
});
