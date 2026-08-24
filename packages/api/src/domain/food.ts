import { z } from 'zod';

/**
 * The canonical food database row. This is the ONLY source of nutrition numbers
 * in the entire system — no model is ever allowed to author these values.
 *
 * Every downstream nutrition figure is `per100g * grams / 100`, so a wrong
 * number here is a data bug we can fix once, not a hallucination we have to
 * detect per-request.
 */
export const NutrientsPer100g = z.object({
  kcal: z.number().nonnegative(),
  proteinG: z.number().nonnegative(),
  carbG: z.number().nonnegative(),
  fatG: z.number().nonnegative(),
  fiberG: z.number().nonnegative().default(0),
});
export type NutrientsPer100g = z.infer<typeof NutrientsPer100g>;

/**
 * A household measure with its gram weight, e.g. "1 slice" = 28g.
 * Sourced with the food row so portion conversion stays deterministic.
 */
export const HouseholdMeasure = z.object({
  /** Canonical unit token, e.g. "slice", "cup", "medium", "tbsp". */
  unit: z.string().min(1),
  /** Grams for ONE of this measure. */
  grams: z.number().positive(),
  /**
   * Plausible spread for this measure, as a multiplier on `grams`.
   * "1 medium apple" is far less certain than "1 tbsp olive oil".
   */
  spread: z.number().min(0).max(1).default(0.15),
});
export type HouseholdMeasure = z.infer<typeof HouseholdMeasure>;

export const FoodState = z.enum(['raw', 'cooked', 'fried', 'grilled', 'boiled', 'baked', 'n/a']);
export type FoodState = z.infer<typeof FoodState>;

export const CanonicalFood = z.object({
  /** Stable ID. `fdc:*` = USDA FoodData Central, `tr:*` = Turkish reference set. */
  id: z.string().min(1),
  /** Primary display name (English). */
  name: z.string().min(1),
  /** Localised names, keyed by BCP-47 language tag. */
  names: z.record(z.string(), z.string()).default({}),
  /**
   * Search aliases — spellings, regional names, common misspellings, brand-free
   * synonyms. The lexical layer indexes these, so adding an alias is the
   * cheapest possible accuracy fix (no model call, no retraining).
   */
  aliases: z.array(z.string()).default([]),
  /** Coarse group, used for sanity rules and error analysis slicing. */
  group: z.enum([
    'grain', 'protein', 'dairy', 'vegetable', 'fruit', 'fat', 'beverage',
    'sweet', 'legume', 'nut', 'condiment', 'composite',
  ]),
  /** Cooking state this row's numbers describe. Raw vs fried is a huge kcal delta. */
  state: FoodState.default('n/a'),
  per100g: NutrientsPer100g,
  /** Grams per household measure. `unit: "g"` is always implicit. */
  measures: z.array(HouseholdMeasure).default([]),
  /** g/ml, for inputs given in volume ("a glass of milk"). */
  densityGPerMl: z.number().positive().optional(),
  /** Where the numbers came from — printed in the UI so any figure is auditable. */
  source: z.string().min(1),
  /**
   * Composite dishes decompose into other canonical foods.
   * Retrieval over single-ingredient rows structurally cannot handle "menemen";
   * this is the escape hatch. Ratios are grams per 100g of finished dish.
   */
  composedOf: z
    .array(z.object({ foodId: z.string(), gramsPer100g: z.number().positive() }))
    .default([]),
});
export type CanonicalFood = z.infer<typeof CanonicalFood>;

export const FoodDatabase = z.array(CanonicalFood);
export type FoodDatabase = z.infer<typeof FoodDatabase>;

/** Zero nutrients — the identity element for summing a meal. */
export const ZERO_NUTRIENTS: NutrientsPer100g = {
  kcal: 0,
  proteinG: 0,
  carbG: 0,
  fatG: 0,
  fiberG: 0,
};
