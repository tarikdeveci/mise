import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadFoodDb } from './foodDb.js';
import { normalizeText } from '../pipeline/normalize.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = resolve(HERE, '../../../../data/golden/cases.json');

const db = loadFoodDb();

describe('food database', () => {
  it('loads and passes every integrity check', () => {
    expect(db.all.length).toBeGreaterThan(50);
  });

  it('resolves aliases in both languages without a model', () => {
    expect(db.byAlias(normalizeText('kaşar'))?.id).toBe('tr:kasar');
    expect(db.byAlias(normalizeText('kasar'))?.id).toBe('tr:kasar');
    expect(db.byAlias(normalizeText('zeytinyağı'))?.id).toBe('fdc:171413');
    expect(db.byAlias(normalizeText('olive oil'))?.id).toBe('fdc:171413');
  });

  it('keeps the ambiguity pairs the golden set depends on genuinely distinct', () => {
    const pairs: Array<[string, string]> = [
      ['fdc:171304', 'fdc:330137'],  // plain vs Greek yogurt
      ['fdc:170026', 'fdc:170032'],  // boiled vs fried potato
      ['fdc:169756', 'fdc:169708'],  // cooked vs raw rice
      ['fdc:171284', 'fdc:170859'],  // milk vs cream
      ['fdc:175040', 'fdc:175041'],  // regular vs diet cola
      ['fdc:171477', 'fdc:171123'],  // grilled vs fried chicken
    ];
    for (const [a, b] of pairs) {
      const fa = db.byId(a);
      const fb = db.byId(b);
      expect(fa, `missing ${a}`).toBeDefined();
      expect(fb, `missing ${b}`).toBeDefined();
      // If two "different" foods have near-identical energy, the golden case
      // built on them proves nothing. Require a meaningful gap.
      const ratio = fa!.per100g.kcal / Math.max(fb!.per100g.kcal, 0.5);
      expect(Math.abs(Math.log(ratio)), `${a} vs ${b} are too similar to test`)
        .toBeGreaterThan(0.15);
    }
  });

  it('gives every food a default measure or is mass-only by design', () => {
    const missing = db.all.filter((f) => f.measures.length === 0).map((f) => f.id);
    expect(missing, 'foods with no measure cannot be portioned from a bare mention').toEqual([]);
  });

  it('cites a source for every row, so any number shown is auditable', () => {
    expect(db.all.filter((f) => !f.source.trim()).map((f) => f.id)).toEqual([]);
  });
});

describe('golden set integrity', () => {
  const cases = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Array<{
    id: string;
    stratum: string;
    expected: Array<{ foodId: string; grams: number }>;
  }>;

  it('has all three strata represented', () => {
    const strata = new Set(cases.map((c) => c.stratum));
    expect([...strata].sort()).toEqual(['adversarial', 'ambiguous', 'easy']);
  });

  it('has unique case ids', () => {
    const ids = cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('references only foods that exist — a bad label is worse than no label', () => {
    const bad: string[] = [];
    for (const c of cases) {
      for (const e of c.expected) {
        if (!db.byId(e.foodId)) bad.push(`${c.id} → ${e.foodId}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('labels positive gram amounts', () => {
    const bad = cases.flatMap((c) =>
      c.expected.filter((e) => !(e.grams > 0)).map((e) => `${c.id} → ${e.grams}g`),
    );
    expect(bad).toEqual([]);
  });

  it('includes refusal cases where the correct answer is an empty log', () => {
    expect(cases.filter((c) => c.expected.length === 0).length).toBeGreaterThanOrEqual(3);
  });
});
