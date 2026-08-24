import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { CanonicalFood, FoodDatabase, type HouseholdMeasure } from '../domain/food.js';
import { normalizeText } from '../pipeline/normalize.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SEED = resolve(HERE, '../../../../data/foods/seed.json');

export interface FoodDb {
  all: CanonicalFood[];
  byId(id: string): CanonicalFood | undefined;
  /** Exact alias hit — the cheapest possible resolution, no model involved. */
  byAlias(normalizedPhrase: string): CanonicalFood | undefined;
  /** Every searchable surface form, for the lexical scorer. */
  surfaces: ReadonlyArray<{ foodId: string; text: string; tokens: string[] }>;
  /** Default portion when the user states no quantity: the food's first measure. */
  defaultMeasure(food: CanonicalFood): HouseholdMeasure | undefined;
  measureFor(food: CanonicalFood, unit: string): HouseholdMeasure | undefined;
}

export class FoodDbError extends Error {
  constructor(message: string, readonly issues: string[]) {
    super(`${message}\n  - ${issues.join('\n  - ')}`);
    this.name = 'FoodDbError';
  }
}

/**
 * Loads and validates the canonical food database.
 *
 * Validation is strict and fail-fast: a malformed seed is a deploy-time error,
 * never a runtime surprise that silently degrades accuracy. Every integrity
 * problem we can catch here is one we never have to debug from a bad meal log.
 */
export function loadFoodDb(seedPath: string = DEFAULT_SEED): FoodDb {
  const raw: unknown = JSON.parse(readFileSync(seedPath, 'utf8'));

  const parsed = FoodDatabase.safeParse(raw);
  if (!parsed.success) {
    throw new FoodDbError(
      `Invalid food seed at ${seedPath}`,
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    );
  }
  const foods = parsed.data;

  const byId = new Map<string, CanonicalFood>();
  const issues: string[] = [];

  for (const food of foods) {
    if (byId.has(food.id)) issues.push(`duplicate food id: ${food.id}`);
    byId.set(food.id, food);
  }

  // Composite rows must point at rows that exist, or decomposition silently
  // drops ingredients and under-counts the meal.
  for (const food of foods) {
    for (const part of food.composedOf) {
      if (!byId.has(part.foodId)) {
        issues.push(`${food.id}: composedOf references unknown food ${part.foodId}`);
      }
    }
  }

  const aliasIndex = new Map<string, string>();
  const collisions = new Map<string, string[]>();

  for (const food of foods) {
    const forms = [food.name, ...Object.values(food.names), ...food.aliases];
    for (const form of forms) {
      const key = normalizeText(form);
      if (!key) continue;
      const existing = aliasIndex.get(key);
      if (existing && existing !== food.id) {
        // An alias pointing at two foods is worse than no alias: it makes the
        // fast path silently wrong. Surface it instead of picking arbitrarily.
        collisions.set(key, [...(collisions.get(key) ?? [existing]), food.id]);
        continue;
      }
      aliasIndex.set(key, food.id);
    }
  }

  for (const [key, ids] of collisions) {
    issues.push(`alias "${key}" is claimed by multiple foods: ${ids.join(', ')}`);
  }

  if (issues.length > 0) throw new FoodDbError(`Food seed integrity check failed`, issues);

  const surfaces = foods.flatMap((food) => {
    const forms = new Set(
      [food.name, ...Object.values(food.names), ...food.aliases].map(normalizeText).filter(Boolean),
    );
    return [...forms].map((text) => ({ foodId: food.id, text, tokens: text.split(' ') }));
  });

  return {
    all: foods,
    byId: (id) => byId.get(id),
    byAlias: (phrase) => {
      const id = aliasIndex.get(phrase);
      return id ? byId.get(id) : undefined;
    },
    surfaces,
    defaultMeasure: (food) => food.measures[0],
    measureFor: (food, unit) => {
      const u = normalizeText(unit);
      return food.measures.find((m) => normalizeText(m.unit) === u);
    },
  };
}
