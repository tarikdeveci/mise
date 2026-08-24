import type { ExtractedItem, ExtractionResult, MealInput } from '../../domain/log.js';
import { canonicalUnit, normalizeText, parseQuantity } from '../normalize.js';
import type { Extractor } from './types.js';

/**
 * Rule-based text extractor — the v0 baseline.
 *
 * No network, no key, no variance. It exists for three reasons:
 *
 *  1. **A baseline to beat.** "Our LLM pipeline scores 82%" means nothing
 *     without knowing that splitting on conjunctions already scores 61%. Half
 *     the accuracy claims in this product category are missing this number.
 *  2. **A fallback.** When the model provider is down or rate-limited, the
 *     endpoint degrades to this instead of failing. Text-only logging keeps
 *     working; the user sees "needs review" rather than an error.
 *  3. **A free CI gate.** The regression suite runs this path on every commit
 *     with no API spend and no flakiness.
 *
 * It cannot see photos and it does not understand grammar. That is the point:
 * everything it gets right is accuracy the model tier never has to buy.
 */

/**
 * Conjunctions and separators that reliably delimit food items.
 *
 * Boundaries are explicit whitespace lookarounds rather than `\b`, because
 * JavaScript's `\b` is defined over ASCII `\w`: `\büzerine\b` never fires on
 * real Turkish text, so "ekmek üzerine tereyağı" silently stayed one fragment
 * and the butter was dropped.
 */
const SEPARATOR_WORDS = [
  've', 'and', 'with', 'ile', 'plus', 'arti', 'artı',
  'yaninda', 'yanında', 'uzerine', 'üzerine', 'yanina', 'yanına',
];
const SPLIT_PATTERN = new RegExp(
  `[,;+&]|(?<=^|\\s)(?:${SEPARATOR_WORDS.join('|')})(?=\\s|$)`,
  'giu',
);

/**
 * Cooking fat stated in the phrase itself: "fried in butter", "zeytinyağında".
 *
 * Fat added during cooking is the single largest systematic undercount in
 * dietary logging — it is invisible in a photo and usually unsaid in text, and
 * a tablespoon of oil is ~120 kcal. When the user DOES mention it, dropping it
 * is inexcusable, so we lift it into its own item.
 */
const COOKING_FAT_PATTERNS: Array<{ re: RegExp; phrase: string; grams: number }> = [
  { re: /\b(?:fried|cooked|sauteed|sautéed)\s+in\s+butter\b/i, phrase: 'tereyağı', grams: 14 },
  { re: /\b(?:fried|cooked|sauteed|sautéed)\s+in\s+(?:olive\s+)?oil\b/i, phrase: 'zeytinyağı', grams: 13.5 },
  { re: /tereyag[ıi]nda|tereyağında/i, phrase: 'tereyağı', grams: 14 },
  { re: /zeytinyag[ıi]nda|zeytinyağında/i, phrase: 'zeytinyağı', grams: 13.5 },
];

/** Phrases stating that nothing was eaten. An empty log is the right answer. */
const NEGATIONS = [
  'bir sey yemedim', 'hicbir sey yemedim', 'ac kaldim',
  'nothing', 'i did not eat', 'didnt eat', 'skipped',
];

/**
 * Text that is trying to instruct the system rather than describe a meal.
 * Meal text is untrusted input: it reaches a model, so it is an injection
 * surface. The rule tier refuses it before any model sees it.
 */
const INJECTION_MARKERS = [
  'ignore previous', 'ignore all previous', 'disregard', 'system prompt',
  'you are now', 'new instructions', 'act as',
];

export function createRuleExtractor(): Extractor {
  return {
    id: 'rules-v1',
    model: 'deterministic',
    supportsVision: false,
    promptVersion: 'rules-v1',

    async extract(input: MealInput): Promise<ExtractionResult> {
      const text = input.text?.trim();
      if (!text) {
        return {
          items: [],
          notFood: false,
          note: 'Rule extractor cannot read images; no text was provided.',
        };
      }

      const flat = normalizeText(text);

      if (INJECTION_MARKERS.some((m) => flat.includes(m))) {
        return { items: [], notFood: true, note: 'Input looks like an instruction, not a meal.' };
      }
      if (NEGATIONS.some((n) => flat.includes(n))) {
        return { items: [], notFood: false, note: 'Nothing eaten.' };
      }

      const fragments = text
        .split(SPLIT_PATTERN)
        .map((f) => f.trim())
        .filter((f) => f.length > 1);

      const items = fragments
        .map(toItem)
        .filter((i): i is ExtractedItem => i !== null);

      // Lift any explicitly stated cooking fat into its own item, and strip the
      // clause from the host phrase — "2 eggs fried in butter" must resolve as
      // "2 eggs" plus butter, not as one phrase that matches neither.
      for (const fat of COOKING_FAT_PATTERNS) {
        if (!fat.re.test(text)) continue;
        for (const item of items) {
          item.phrase = item.phrase.replace(fat.re, (m) => (/\bin\b/i.test(m) ? 'fried' : '')).trim();
        }
        if (items.some((i) => normalizeText(i.phrase).includes(normalizeText(fat.phrase)))) continue;
        items.push({
          phrase: fat.phrase,
          quantity: fat.grams,
          unit: 'g',
          preparation: 'unknown',
          // Stated but unquantified: we are sure it is there, not how much.
          confidence: 0.6,
        });
      }

      return { items, notFood: items.length === 0, ...(items.length === 0 ? { note: 'No food terms found.' } : {}) };
    },

    lastUsage: () => ({ inputTokens: 0, outputTokens: 0, costUsd: 0 }),
  };
}

function toItem(fragment: string): ExtractedItem | null {
  const { value, vague } = parseQuantity(fragment);
  const unit = findUnit(fragment);

  const phrase = fragment.trim();
  if (!normalizeText(phrase)) return null;

  return {
    phrase,
    ...(value !== undefined ? { quantity: value } : {}),
    ...(unit ? { unit } : {}),
    preparation: detectPreparation(fragment),
    // A rule tier has no model to report certainty, so it reports the truth:
    // moderate on a clean fragment, lower when the amount was hedged.
    confidence: vague ? 0.55 : 0.7,
  };
}

function findUnit(fragment: string): string | undefined {
  for (const token of normalizeText(fragment).split(' ')) {
    if (canonicalUnit(token)) return token;
  }
  // Two-word Turkish measures ("çay kaşığı", "yemek kaşığı").
  const flat = normalizeText(fragment);
  for (const phrase of ['cay kasigi', 'yemek kasigi', 'corba kasigi']) {
    if (flat.includes(phrase)) return phrase;
  }
  return undefined;
}

const PREPARATION_MARKERS: Array<[ExtractedItem['preparation'], string[]]> = [
  ['fried', ['fried', 'kizarmis', 'kizartmasi', 'sahanda', 'crispy']],
  ['grilled', ['grilled', 'izgara', 'mangal']],
  ['boiled', ['boiled', 'haslanmis', 'haslama']],
  ['baked', ['baked', 'firinda', 'firinlanmis']],
  ['raw', ['raw', 'cig', 'taze']],
  ['cooked', ['cooked', 'pismis']],
];

function detectPreparation(fragment: string): ExtractedItem['preparation'] {
  const flat = normalizeText(fragment);
  for (const [state, markers] of PREPARATION_MARKERS) {
    if (markers.some((m) => flat.includes(m))) return state;
  }
  return 'unknown';
}
