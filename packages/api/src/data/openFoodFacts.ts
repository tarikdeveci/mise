import { z } from 'zod';
import type { CanonicalFood } from '../domain/food.js';
import type { BarcodeFacts } from '../pipeline/portion/types.js';
import { logger } from '../obs/logger.js';
import { metrics } from '../obs/metrics.js';
import { withRetry } from '../util/retry.js';

/**
 * Open Food Facts lookup.
 *
 * The top rung of the portion ladder, and the only path through this system
 * that touches no model at all: a barcode identifies the product exactly and
 * the label states the nutrition, so identification error and portion error
 * both go to roughly zero. Commercial barcode databases claim >90% coverage of
 * packaged goods, which is a large share of what people actually log.
 *
 * Open Food Facts is community-maintained and free, which makes it the right
 * choice for a case study and the wrong one for production: coverage is uneven
 * outside Europe and entries can be incomplete or wrong. The validation below
 * is therefore not ceremony — a product row missing energy, or carrying
 * implausible values, is rejected rather than shown, because a number sourced
 * from a stranger's phone camera is not automatically better than our own
 * estimate.
 */

const BASE_URL = process.env.OFF_BASE_URL ?? 'https://world.openfoodfacts.org';

/** Identify ourselves, as Open Food Facts asks API clients to do. */
const USER_AGENT = 'mise-mealogging/0.1 (case study; contact via repository)';

const Nutriments = z.object({
  'energy-kcal_100g': z.number().optional(),
  proteins_100g: z.number().optional(),
  carbohydrates_100g: z.number().optional(),
  fat_100g: z.number().optional(),
  fiber_100g: z.number().optional(),
});

const OffResponse = z.object({
  status: z.number(),
  product: z
    .object({
      product_name: z.string().optional(),
      product_name_tr: z.string().optional(),
      brands: z.string().optional(),
      quantity: z.string().optional(),
      serving_quantity: z.union([z.number(), z.string()]).optional(),
      nutriments: Nutriments.optional(),
    })
    .optional(),
});

export interface BarcodeLookup {
  food: CanonicalFood;
  facts: BarcodeFacts;
}

export class BarcodeNotFound extends Error {
  constructor(readonly code: string, readonly why: string) {
    super(`No usable nutrition for barcode ${code}: ${why}`);
    this.name = 'BarcodeNotFound';
  }
}

/** Energy above this per 100 g is not food; the row is bad data. */
const MAX_PLAUSIBLE_KCAL_100G = 950;

export async function lookupBarcode(code: string): Promise<BarcodeLookup> {
  const url =
    `${BASE_URL}/api/v2/product/${encodeURIComponent(code)}.json` +
    `?fields=product_name,product_name_tr,brands,quantity,serving_quantity,nutriments`;

  const started = Date.now();
  const res = await withRetry(
    async () => {
      const r = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
      if (!r.ok) {
        const err = new Error(`Open Food Facts returned ${r.status}`) as Error & { status: number };
        err.status = r.status;
        throw err;
      }
      return r.json() as Promise<unknown>;
    },
    { label: 'openfoodfacts.lookup', attempts: 2 },
  );

  metrics.observe('barcode_lookup_ms', Date.now() - started);

  const parsed = OffResponse.safeParse(res);
  if (!parsed.success || parsed.data.status !== 1 || !parsed.data.product) {
    metrics.inc('barcode_lookup_total', { outcome: 'not_found' });
    throw new BarcodeNotFound(code, 'the product is not in Open Food Facts');
  }

  const p = parsed.data.product;
  const kcal = p.nutriments?.['energy-kcal_100g'];

  if (kcal === undefined) {
    metrics.inc('barcode_lookup_total', { outcome: 'no_energy' });
    throw new BarcodeNotFound(code, 'the entry has no energy value');
  }
  if (kcal < 0 || kcal > MAX_PLAUSIBLE_KCAL_100G) {
    // Pure fat is 900 kcal/100 g; anything above that is a data-entry error,
    // and a community database has plenty of those.
    metrics.inc('barcode_lookup_total', { outcome: 'implausible' });
    throw new BarcodeNotFound(code, `${kcal} kcal/100 g is not plausible`);
  }

  const name = [p.brands?.split(',')[0]?.trim(), p.product_name_tr ?? p.product_name]
    .filter(Boolean)
    .join(' ')
    .trim() || `Product ${code}`;

  const servingGrams = toGrams(p.serving_quantity);

  const food: CanonicalFood = {
    id: `off:${code}`,
    name,
    names: {},
    aliases: [],
    // Packaged products are their own thing; forcing them into a food group
    // would be a guess, and `composite` is the honest bucket for "a made item".
    group: 'composite',
    state: 'n/a',
    per100g: {
      kcal: round(kcal),
      proteinG: round(p.nutriments?.proteins_100g ?? 0),
      carbG: round(p.nutriments?.carbohydrates_100g ?? 0),
      fatG: round(p.nutriments?.fat_100g ?? 0),
      fiberG: round(p.nutriments?.fiber_100g ?? 0),
    },
    measures: servingGrams
      ? [{ unit: 'serving', grams: servingGrams, spread: 0.08 }]
      : [{ unit: 'portion', grams: 100, spread: 0.35 }],
    composedOf: [],
    source: `Open Food Facts, barcode ${code}`,
  };

  metrics.inc('barcode_lookup_total', { outcome: 'ok' });
  logger.info({ code, name, kcal, servingGrams }, 'barcode resolved');

  return {
    food,
    facts: {
      code,
      name,
      source: 'Open Food Facts',
      ...(servingGrams !== undefined ? { servingGrams } : {}),
    },
  };
}

function toGrams(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = typeof value === 'number' ? value : Number.parseFloat(value);
  // A serving of 0 g, or one heavier than a kilo, is a broken entry rather than
  // a very large snack.
  return Number.isFinite(n) && n > 0 && n <= 1000 ? Number(n.toFixed(1)) : undefined;
}

const round = (n: number): number => Number(n.toFixed(2));
