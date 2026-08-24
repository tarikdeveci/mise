import type { ExtractedItem } from '../domain/log.js';
import { normalizeText } from './normalize.js';

/**
 * Recipe expansion for dishes with no database row of their own.
 *
 * Retrieval over a single-ingredient food table structurally cannot answer
 * "tost": there is no row for it, and the nearest match ("toast bread") loses
 * the cheese entirely — a ~140 kcal silent undercount. A dish either needs its
 * own composed row (menemen, mercimek çorbası — see the seed) or a template
 * here that expands it into the items it is actually made of.
 *
 * Templates run BEFORE resolution and are deliberately deterministic: a
 * composite is a recipe, and recipes are knowledge we can write down rather
 * than inference we have to pay for and then verify.
 */

interface TemplatePart {
  phrase: string;
  quantity: number;
  unit?: string;
}

interface RecipeTemplate {
  /** Matched against the normalised phrase, whole-word. */
  match: string[];
  parts: TemplatePart[];
  note: string;
}

const TEMPLATES: RecipeTemplate[] = [
  {
    match: ['tost', 'kasarli tost', 'peynirli tost', 'cheese toast'],
    parts: [
      { phrase: 'beyaz ekmek', quantity: 2, unit: 'slice' },
      { phrase: 'kasar', quantity: 2, unit: 'slice' },
    ],
    note: 'tost = 2 slices bread + 2 slices kaşar',
  },
  {
    match: ['ekmek arasi kofte', 'kofte ekmek'],
    parts: [
      { phrase: 'beyaz ekmek', quantity: 3, unit: 'slice' },
      { phrase: 'kofte', quantity: 3, unit: 'piece' },
    ],
    note: 'ekmek arası köfte = bread + 3 köfte',
  },
  {
    match: ['tavuklu salata', 'chicken salad'],
    parts: [
      { phrase: 'yesil salata', quantity: 1, unit: 'bowl' },
      { phrase: 'tavuk gogsu', quantity: 100, unit: 'g' },
    ],
    note: 'chicken salad = greens + 100 g chicken breast',
  },
];

export interface ExpansionResult {
  items: ExtractedItem[];
  /** Notes for any expansion that happened, surfaced in the debug trace. */
  notes: string[];
}

/**
 * Expands any templated dish into its parts, leaving everything else untouched.
 *
 * Confidence is inherited and then discounted: a recipe template is a
 * reasonable default, not an observation of what this particular person ate,
 * and the confidence shown to the user should say so.
 */
export function expandComposites(items: ExtractedItem[]): ExpansionResult {
  const out: ExtractedItem[] = [];
  const notes: string[] = [];

  for (const item of items) {
    const flat = normalizeText(item.phrase);
    const template = TEMPLATES.find((t) =>
      t.match.some((m) => flat === m || new RegExp(`\\b${m}\\b`).test(flat)),
    );

    if (!template) {
      out.push(item);
      continue;
    }

    // "2 tost" means two of everything in the recipe.
    const multiplier = item.quantity ?? 1;
    notes.push(`${item.phrase} → ${template.note}`);

    for (const part of template.parts) {
      out.push({
        phrase: part.phrase,
        quantity: part.quantity * multiplier,
        ...(part.unit ? { unit: part.unit } : {}),
        preparation: item.preparation,
        confidence: Number((item.confidence * 0.85).toFixed(2)),
      });
    }
  }

  return { items: out, notes };
}
