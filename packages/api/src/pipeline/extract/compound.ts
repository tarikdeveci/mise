import type { ExtractedItem } from '../../domain/log.js';
import { canonicalUnit, normalizeText, stemPhrase } from '../normalize.js';

/**
 * Puts back together a dish the extractor took apart.
 *
 * Turkish builds an adjective out of a noun with -lı/-li/-lu/-lü ("yumurtalı",
 * "peynirli", "sütlü") and its negative with -sız/-siz/-suz/-süz. The result
 * names ONE thing: "yumurtalı noodle" is egg noodles — the egg is in the dough
 * — and not an egg served next to a bowl of plain noodles. Extractors read the
 * prompt's "split distinct foods" rule and split it anyway, which turns one
 * item into two, logs an egg nobody ate, and gets the noodles wrong as well.
 *
 * The fix cannot be morphology alone, because the same construction also
 * describes genuinely separable meals: "kıymalı makarna" really is pasta plus
 * mince, and counting them apart is the more accurate answer there. So the test
 * is not "does this look like a compound" but **"can we cite a single database
 * row for the whole phrase"**. If we can, the compound is a food and the split
 * was an error. If we cannot, the split stands and each half resolves on its
 * own — which is exactly the behaviour this system had before.
 *
 * Runs before recipe expansion, so a rejoined compound can still be a template.
 */

/** Folded forms of the Turkish derivational suffixes, longest first. */
const MODIFIER_SUFFIXES = ['siz', 'suz', 'li', 'lu'] as const;

/** "etli" is a modifier; a three-letter word ending in -li is a coincidence. */
const MIN_MODIFIER_LENGTH = 4;
/** Below this the stem is not a food name, it is two letters. */
const MIN_STEM_LENGTH = 2;
/** The head noun of a compound. Shorter than this is a particle, not a dish. */
const MIN_HEAD_LENGTH = 3;

export interface CompoundMergeResult {
  items: ExtractedItem[];
  /** One line per rejoin, for the debug trace. */
  notes: string[];
}

/**
 * @param namesOneFood Whether the joined phrase resolves to a single database
 *   row. Supplied by the caller rather than imported, so this stays a pure
 *   function over words and the food database stays out of the extract layer.
 */
export function mergeModifierCompounds(
  items: ExtractedItem[],
  sourceText: string | undefined,
  namesOneFood: (phrase: string) => boolean,
): CompoundMergeResult {
  const text = sourceText?.trim();
  if (!text || items.length < 2) return { items, notes: [] };

  const words = text.split(/\s+/).filter(Boolean);
  const notes: string[] = [];
  const merged = new Map<number, ExtractedItem>();
  const dropped = new Set<number>();

  for (let i = 0; i < words.length - 1; i++) {
    const stem = modifierStem(words[i]!);
    if (!stem) continue;

    const head = normalizeText(words[i + 1]!);
    if (head.length < MIN_HEAD_LENGTH || canonicalUnit(head)) continue;

    const compound = `${words[i]} ${words[i + 1]}`;
    if (!namesOneFood(compound)) continue;

    const modifierAt = items.findIndex((item, at) => !dropped.has(at) && mentions(item, stem));
    if (modifierAt === -1) continue;
    const headAt = items.findIndex((item, at) => !dropped.has(at) && at !== modifierAt && mentions(item, head));
    if (headAt === -1) continue;

    // Extractors emit items in the order the text names them, so the two halves
    // of one compound land next to each other. Requiring that is what keeps
    // "yumurtalı noodle ve 1 yumurta" from swallowing the second egg.
    if (Math.abs(modifierAt - headAt) !== 1) continue;

    const at = Math.min(modifierAt, headAt);
    merged.set(at, join(compound, items[modifierAt]!, items[headAt]!));
    dropped.add(modifierAt);
    dropped.add(headAt);
    notes.push(`"${items[modifierAt]!.phrase}" + "${items[headAt]!.phrase}" → "${compound}"`);
  }

  if (merged.size === 0) return { items, notes: [] };

  const out: ExtractedItem[] = [];
  for (const [at, item] of items.entries()) {
    const replacement = merged.get(at);
    if (replacement) out.push(replacement);
    else if (!dropped.has(at)) out.push(item);
  }
  return { items: out, notes };
}

/** The noun inside a modifier: "yumurtalı" → "yumurta", "şekersiz" → "şeker". */
function modifierStem(word: string): string | null {
  const folded = normalizeText(word);
  if (folded.length < MIN_MODIFIER_LENGTH || folded.includes(' ')) return null;
  for (const suffix of MODIFIER_SUFFIXES) {
    if (!folded.endsWith(suffix)) continue;
    const stem = folded.slice(0, -suffix.length);
    return stem.length >= MIN_STEM_LENGTH ? stem : null;
  }
  return null;
}

/** True when one of the item's own words is this noun, inflection allowed. */
function mentions(item: ExtractedItem, word: string): boolean {
  const tokens = new Set(stemPhrase(normalizeText(item.phrase)).split(' '));
  return tokens.has(stemPhrase(word));
}

/**
 * Combines the two halves back into one item.
 *
 * Confidence takes the lower of the two on purpose: the extractor read this as
 * two foods and we are overruling it, so the result is a weaker claim than
 * either half was, and the band it lands in should say so.
 */
function join(phrase: string, modifier: ExtractedItem, head: ExtractedItem): ExtractedItem {
  const quantity = head.quantity ?? modifier.quantity;
  const unit = head.unit ?? modifier.unit;
  const preparation = head.preparation !== 'unknown' ? head.preparation : modifier.preparation;
  const brand = head.brand ?? modifier.brand;

  return {
    phrase,
    ...(quantity !== undefined ? { quantity } : {}),
    ...(unit !== undefined ? { unit } : {}),
    preparation,
    ...(brand !== undefined ? { brand } : {}),
    confidence: Math.min(modifier.confidence, head.confidence),
  };
}
