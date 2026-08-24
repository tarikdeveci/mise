import type { CanonicalFood, NutrientsPer100g } from '../domain/food.js';
import { ZERO_NUTRIENTS } from '../domain/food.js';
import type { NutritionInterval, PortionEstimate } from '../domain/log.js';

/**
 * Nutrition computation.
 *
 * This entire file is arithmetic over a database row. There is no model here,
 * no heuristic, and no judgement — which is precisely the point. Because every
 * figure we ever display is produced by this function, "the AI made up a
 * calorie count" is not a failure mode this system has. It is not rare; it is
 * absent by construction, and `verifyTraceable` below is the assertion that
 * keeps it that way.
 */

const round = (n: number): number => Number(n.toFixed(2));

function scale(per100g: NutrientsPer100g, grams: number): NutrientsPer100g {
  const f = grams / 100;
  return {
    kcal: round(per100g.kcal * f),
    proteinG: round(per100g.proteinG * f),
    carbG: round(per100g.carbG * f),
    fatG: round(per100g.fatG * f),
    fiberG: round(per100g.fiberG * f),
  };
}

/**
 * Propagates the portion interval through to nutrition.
 *
 * Every nutrient scales linearly with mass, so the interval maps directly:
 * no sampling, no Monte Carlo, no error term to tune. The kcal range the user
 * sees is exactly the gram range we admitted to.
 */
export function computeNutrition(food: CanonicalFood, portion: PortionEstimate): NutritionInterval {
  return {
    likely: scale(food.per100g, portion.gramsLikely),
    min: scale(food.per100g, portion.gramsMin),
    max: scale(food.per100g, portion.gramsMax),
  };
}

export function addNutrients(a: NutrientsPer100g, b: NutrientsPer100g): NutrientsPer100g {
  return {
    kcal: round(a.kcal + b.kcal),
    proteinG: round(a.proteinG + b.proteinG),
    carbG: round(a.carbG + b.carbG),
    fatG: round(a.fatG + b.fatG),
    fiberG: round(a.fiberG + b.fiberG),
  };
}

export function sumIntervals(intervals: NutritionInterval[]): NutritionInterval {
  return intervals.reduce<NutritionInterval>(
    (acc, cur) => ({
      likely: addNutrients(acc.likely, cur.likely),
      min: addNutrients(acc.min, cur.min),
      max: addNutrients(acc.max, cur.max),
    }),
    { likely: ZERO_NUTRIENTS, min: ZERO_NUTRIENTS, max: ZERO_NUTRIENTS },
  );
}

/**
 * Asserts that a displayed figure really is `per100g * grams / 100`.
 *
 * This guards taxonomy code E11 (nutrition not traceable to a database row).
 * E11 should be structurally impossible; this function is what turns that
 * claim from an argument into a test. The eval harness runs it over every
 * item of every case, so a boundary leak fails the build rather than shipping.
 */
export function verifyTraceable(
  food: CanonicalFood,
  portion: PortionEstimate,
  claimed: NutritionInterval,
  toleranceKcal = 0.05,
): { ok: true } | { ok: false; reason: string } {
  const expected = computeNutrition(food, portion);
  const delta = Math.abs(expected.likely.kcal - claimed.likely.kcal);
  if (delta > toleranceKcal) {
    return {
      ok: false,
      reason:
        `kcal not traceable to ${food.id}: expected ${expected.likely.kcal} ` +
        `(= ${food.per100g.kcal}/100g x ${portion.gramsLikely}g), got ${claimed.likely.kcal}`,
    };
  }
  if (claimed.min.kcal > claimed.likely.kcal || claimed.likely.kcal > claimed.max.kcal) {
    return { ok: false, reason: `interval is not ordered: ${claimed.min.kcal} / ${claimed.likely.kcal} / ${claimed.max.kcal}` };
  }
  return { ok: true };
}
