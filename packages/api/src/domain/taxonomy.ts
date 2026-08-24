/**
 * Error taxonomy.
 *
 * Every eval failure is assigned exactly one of these codes. Without a
 * taxonomy an accuracy number is just a scalar that goes up or down for
 * unknown reasons; with one, each run tells you *which* subsystem to fix.
 *
 * The `owner` field maps a failure class to the component that can fix it —
 * so a regression points at a directory, not at "the AI".
 */
export const ERROR_TAXONOMY = {
  E1_WRONG_FOOD: {
    label: 'Wrong canonical food',
    example: '"yogurt" → Greek yogurt (plain whole was correct)',
    owner: 'resolve',
  },
  E2_MISSING_ITEM: {
    label: 'Item present but not extracted',
    example: 'Cooking oil in the pan is never mentioned',
    owner: 'extract',
  },
  E3_PHANTOM_ITEM: {
    label: 'Item extracted but not present',
    example: 'Model adds "side salad" that is not in the photo',
    owner: 'extract',
  },
  E4_PORTION: {
    label: 'Right food, wrong mass',
    example: 'Rice logged at 150 g, actually 320 g',
    owner: 'portion',
  },
  E5_UNIT: {
    label: 'Unit or conversion error',
    example: '200 ml milk treated as 200 g (density ignored)',
    owner: 'portion',
  },
  E6_PREPARATION: {
    label: 'Wrong cooking state',
    example: 'Fried potato matched to boiled potato — ~2x kcal',
    owner: 'resolve',
  },
  E7_BRAND: {
    label: 'Brand/generic confusion',
    example: 'Generic cola matched to a diet variant',
    owner: 'resolve',
  },
  E8_COMPOSITE: {
    label: 'Composite dish not decomposed',
    example: '"menemen" matched to plain egg, losing oil/tomato/pepper',
    owner: 'resolve',
  },
  E9_DUPLICATE: {
    label: 'Double counting',
    example: '"cheese toast" logged as both a toast item and a cheese item',
    owner: 'extract',
  },
  E10_LOCALE: {
    label: 'Language/locale failure',
    example: 'Turkish "kaşar" not recognised at all',
    owner: 'resolve',
  },
  E11_HALLUCINATED_NUTRITION: {
    label: 'Nutrition not traceable to a DB row',
    example: 'Numbers do not equal per100g * grams / 100',
    owner: 'nutrition',
  },
  E12_NOT_FOOD: {
    label: 'Non-food input accepted as food',
    example: 'Photo of a laptop returns a meal',
    owner: 'extract',
  },
} as const;

export type ErrorCode = keyof typeof ERROR_TAXONOMY;
export const ERROR_CODES = Object.keys(ERROR_TAXONOMY) as ErrorCode[];

/**
 * E11 is special: it must be structurally impossible, not merely rare.
 * The resolver can only return IDs that exist in the DB, and nutrition is
 * pure arithmetic over that row. If E11 is ever non-zero, a boundary leaked
 * and that is a P0 bug — not a model-quality issue to be prompted away.
 */
export const STRUCTURALLY_IMPOSSIBLE: ErrorCode[] = ['E11_HALLUCINATED_NUTRITION'];

export function ownerOf(code: ErrorCode): string {
  return ERROR_TAXONOMY[code].owner;
}
