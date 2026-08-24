import { describe, it, expect, beforeEach } from 'vitest';
import { loadFoodDb } from '../../data/foodDb.js';
import type { ExtractedItem } from '../../domain/log.js';
import { createAliasStore, type AliasStore } from '../resolve/aliasStore.js';
import { estimatePortion } from './index.js';
import type { PortionContext } from './types.js';

const db = loadFoodDb();
const bread = db.byId('fdc:172687')!;   // 28 g per slice
const milk = db.byId('fdc:171284')!;    // 1.03 g/ml
const chicken = db.byId('fdc:171477')!; // default piece 120 g

let aliases: AliasStore;
beforeEach(() => { aliases = createAliasStore(); });

function ctx(item: Partial<ExtractedItem> & { phrase: string }, over: Partial<PortionContext> = {}): PortionContext {
  return {
    db,
    food: bread,
    userId: 'u1',
    aliases,
    fromImage: false,
    reference: 'none',
    item: { preparation: 'unknown', confidence: 0.9, ...item },
    ...over,
  };
}

const width = (p: { gramsMin: number; gramsMax: number; gramsLikely: number }) =>
  (p.gramsMax - p.gramsMin) / (2 * p.gramsLikely);

describe('portion ladder order', () => {
  it('a stated mass beats everything below it', () => {
    aliases.record('u1', 'ekmek', 'fdc:172687', 999);
    const p = estimatePortion(ctx({ phrase: 'ekmek', quantity: 180, unit: 'g' }));
    expect(p.method).toBe('stated_mass');
    expect(p.gramsLikely).toBe(180);
    // The user weighed it, so the interval collapses to scale rounding.
    expect(width(p)).toBeLessThan(0.03);
  });

  it('a stated volume goes through the food\'s own density', () => {
    const p = estimatePortion(ctx({ phrase: 'süt', quantity: 200, unit: 'ml' }, { food: milk }));
    expect(p.method).toBe('stated_volume');
    expect(p.gramsLikely).toBeCloseTo(206, 0);
  });

  it('a scanned label answers with the serving on the package', () => {
    const p = estimatePortion(ctx({ phrase: 'Some Bar' }, {
      barcode: { code: '123', name: 'Some Bar', source: 'Open Food Facts', servingGrams: 45 },
    }));
    expect(p.method).toBe('barcode_label');
    expect(p.gramsLikely).toBe(45);
  });

  it('replays a portion this user confirmed before', () => {
    aliases.record('u1', 'tavuk', 'fdc:171477', 175);
    const p = estimatePortion(ctx({ phrase: 'tavuk' }, { food: chicken }));
    expect(p.method).toBe('user_memory');
    expect(p.gramsLikely).toBe(175);
    expect(p.assumption).toMatch(/your usual/i);
  });

  it('does not let a remembered portion overrule an amount stated this time', () => {
    aliases.record('u1', 'tavuk', 'fdc:171477', 175);
    const p = estimatePortion(ctx({ phrase: 'tavuk', quantity: 90, unit: 'g' }, { food: chicken }));
    expect(p.method).toBe('stated_mass');
    expect(p.gramsLikely).toBe(90);
  });

  it('keeps one user\'s remembered portion away from another user', () => {
    aliases.record('u1', 'tavuk', 'fdc:171477', 175);
    const p = estimatePortion(ctx({ phrase: 'tavuk' }, { food: chicken, userId: 'u2' }));
    expect(p.method).not.toBe('user_memory');
  });

  it('falls to the measure table for words it understands', () => {
    const p = estimatePortion(ctx({ phrase: '2 dilim ekmek', quantity: 2, unit: 'dilim' }));
    expect(p.method).toBe('household_measure');
    expect(p.gramsLikely).toBe(56);
  });

  it('lands on the model estimate when nothing else can answer', () => {
    const p = estimatePortion(ctx({ phrase: 'ekmek' }));
    expect(p.method).toBe('model_estimate');
  });
});

describe('what the rung is worth', () => {
  it('narrows a photo estimate when a scale reference was in frame', () => {
    const item = { phrase: 'ekmek', quantity: 2, unit: 'dilim' };
    const without = estimatePortion(ctx(item, { fromImage: true }));
    const withCard = estimatePortion(ctx(item, { fromImage: true, reference: 'card' }));

    expect(without.method).toBe('household_measure');
    expect(withCard.method).toBe('reference_scaled');
    // Both read the same words; the reference only changes how sure we are.
    expect(withCard.gramsLikely).toBe(without.gramsLikely);
    expect(width(withCard)).toBeLessThan(width(without));
    expect(withCard.assumption).toMatch(/card/);
  });

  it('never gives a photo reading the tight interval a typed one gets', () => {
    const item = { phrase: 'ekmek', quantity: 2, unit: 'dilim' };
    const typed = estimatePortion(ctx(item));
    const photo = estimatePortion(ctx(item, { fromImage: true }));
    // Measured: the same photo read four times swung the meal 84%.
    expect(width(photo)).toBeGreaterThan(width(typed));
    expect(photo.fromVision).toBe(true);
    expect(typed.fromVision).toBe(false);
  });

  it('orders every interval it produces', () => {
    const cases: PortionContext[] = [
      ctx({ phrase: 'ekmek', quantity: 180, unit: 'g' }),
      ctx({ phrase: 'bir avuç badem' }),
      ctx({ phrase: 'ekmek' }, { fromImage: true }),
      ctx({ phrase: 'ekmek', quantity: 2, unit: 'dilim' }, { fromImage: true, reference: 'coin' }),
    ];
    for (const c of cases) {
      const p = estimatePortion(c);
      expect(p.gramsMin).toBeLessThanOrEqual(p.gramsLikely);
      expect(p.gramsLikely).toBeLessThanOrEqual(p.gramsMax);
      expect(p.gramsMin).toBeGreaterThan(0);
    }
  });
});
