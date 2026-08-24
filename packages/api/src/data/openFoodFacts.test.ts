import { describe, it, expect, vi, afterEach } from 'vitest';
import { lookupBarcode, BarcodeNotFound } from './openFoodFacts.js';

/**
 * Open Food Facts is the one input to this system that nobody here wrote and
 * nobody here reviews: a community database anyone can edit, reached over the
 * network, feeding numbers straight into a health diary. It is also the rung
 * the app presents as its *most* accurate, at +/-0%.
 *
 * That combination is why these tests exist. Everywhere else the system's
 * defence against a bad number is that a model was never allowed to author one;
 * here the number arrives pre-authored by a stranger. The only thing standing
 * between a typo in a public wiki and a user's calorie total is the validation
 * below, so it is worth asserting rather than assuming.
 */

const ok = (product: unknown): Response =>
  ({ ok: true, status: 200, json: async () => ({ status: 1, product }) }) as Response;

const stub = (impl: () => Response | Promise<Response>): void => {
  vi.stubGlobal('fetch', vi.fn(impl));
};

/** A well-formed entry: 250 kcal/100 g, 30 g serving stated on the label. */
const GOOD = {
  product_name: 'Digestive Biscuits',
  brands: 'Ulker, Ülker Turkey',
  serving_quantity: 30,
  nutriments: {
    'energy-kcal_100g': 250,
    proteins_100g: 6.2,
    carbohydrates_100g: 62,
    fat_100g: 20.5,
    fiber_100g: 3,
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('barcode lookup', () => {
  it('turns a label into a canonical food with a citable source', async () => {
    stub(() => ok(GOOD));

    const { food, facts } = await lookupBarcode('8690504016830');

    expect(food.id).toBe('off:8690504016830');
    expect(food.per100g.kcal).toBe(250);
    // The whole point of this rung: the number is attributable to the package.
    expect(food.source).toBe('Open Food Facts, barcode 8690504016830');
    expect(facts.servingGrams).toBe(30);
  });

  it('uses the stated serving as a tight measure, not a guessed portion', async () => {
    stub(() => ok(GOOD));

    const { food } = await lookupBarcode('8690504016830');
    const measure = food.measures[0];

    expect(measure?.unit).toBe('serving');
    expect(measure?.grams).toBe(30);
    // A printed serving is a fact about the package. It gets a narrow spread;
    // the fallback below does not.
    expect(measure?.spread).toBeLessThan(0.1);
  });

  it('falls back to a wide 100 g portion when the label states no serving', async () => {
    stub(() => ok({ ...GOOD, serving_quantity: undefined }));

    const { food, facts } = await lookupBarcode('1');
    const measure = food.measures[0];

    expect(facts.servingGrams).toBeUndefined();
    expect(measure?.grams).toBe(100);
    // Not knowing the serving is a real loss of precision and has to show up
    // as a wider interval, not as the same confident number.
    expect(measure?.spread).toBeGreaterThan(0.3);
  });

  it('prefers the Turkish product name when the entry carries one', async () => {
    stub(() => ok({ ...GOOD, product_name_tr: 'Çay Bisküvisi' }));

    const { food } = await lookupBarcode('1');
    expect(food.name).toContain('Çay Bisküvisi');
    // Only the first brand, not the comma-separated pile OFF often stores.
    expect(food.name).toBe('Ulker Çay Bisküvisi');
  });

  /* ── the reasons a row gets refused ────────────────────────────────── */

  it('refuses an entry with no energy value rather than logging it as zero', async () => {
    stub(() => ok({ ...GOOD, nutriments: { proteins_100g: 6 } }));

    // Silently treating a missing field as 0 kcal is the worst available
    // outcome: a real food, logged, contributing nothing to the day's total.
    await expect(lookupBarcode('1')).rejects.toBeInstanceOf(BarcodeNotFound);
  });

  it('refuses energy that no food can have', async () => {
    // Pure fat is ~900 kcal/100 g. 3500 is a data-entry error, and a public
    // wiki has plenty — usually kJ typed into the kcal field.
    stub(() => ok({ ...GOOD, nutriments: { 'energy-kcal_100g': 3500 } }));

    await expect(lookupBarcode('1')).rejects.toThrow(/not plausible/);
  });

  it('refuses negative energy', async () => {
    stub(() => ok({ ...GOOD, nutriments: { 'energy-kcal_100g': -12 } }));
    await expect(lookupBarcode('1')).rejects.toThrow(/not plausible/);
  });

  it('refuses an unknown barcode instead of inventing a product', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ status: 0 }),
    }) as Response));

    await expect(lookupBarcode('0000000000000')).rejects.toThrow(/not in Open Food Facts/);
  });

  it('does not retry a 404 — a missing product will not appear on the second try', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404 }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    await expect(lookupBarcode('1')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /* ── serving sizes that are typos rather than large snacks ─────────── */

  it.each([
    ['zero', 0],
    ['negative', -30],
    ['heavier than a kilo', 5000],
    ['unparseable', 'one packet'],
  ])('ignores a %s serving size and widens the interval instead', async (_label, serving) => {
    stub(() => ok({ ...GOOD, serving_quantity: serving }));

    const { food, facts } = await lookupBarcode('1');

    expect(facts.servingGrams).toBeUndefined();
    expect(food.measures[0]?.grams).toBe(100);
  });

  it('accepts a serving given as a numeric string, which OFF often stores', async () => {
    stub(() => ok({ ...GOOD, serving_quantity: '33.5' }));

    const { facts } = await lookupBarcode('1');
    expect(facts.servingGrams).toBe(33.5);
  });

  it('fills absent macros with zero but never absent energy', async () => {
    stub(() => ok({ ...GOOD, nutriments: { 'energy-kcal_100g': 250 } }));

    const { food } = await lookupBarcode('1');

    // Macros are secondary and a missing one is survivable. Energy is the
    // number the product exists to report, so its absence is disqualifying —
    // asserted in the test above, and paired here so the asymmetry is explicit.
    expect(food.per100g).toMatchObject({ kcal: 250, proteinG: 0, carbG: 0, fatG: 0, fiberG: 0 });
  });
});
