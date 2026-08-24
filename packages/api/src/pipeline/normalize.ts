/**
 * Deterministic input normalisation.
 *
 * Everything in this file is pure, synchronous, free, and testable. Every
 * ambiguity resolved here is one that never reaches a model — which makes it
 * both cheaper and more reliable than the alternative. When accuracy work has
 * a choice between "add a rule here" and "improve the prompt", this file wins.
 */

/** Turkish characters folded to their ASCII base so "kaşar" matches "kasar". */
const FOLD: Record<string, string> = {
  ı: 'i', İ: 'i', ş: 's', Ş: 's', ğ: 'g', Ğ: 'g',
  ü: 'u', Ü: 'u', ö: 'o', Ö: 'o', ç: 'c', Ç: 'c',
  â: 'a', î: 'i', û: 'u', é: 'e', è: 'e', á: 'a', ñ: 'n',
};

/**
 * Canonical form for matching and indexing.
 *
 * Note this deliberately folds Turkish diacritics rather than using
 * locale-aware casing: users type "kasar" as often as "kaşar", and an index
 * that distinguishes them just moves work to the model for no benefit.
 */
export function normalizeText(input: string): string {
  return input
    .normalize('NFC')
    .replace(/[ıİşŞğĞüÜöÖçÇâîûéèáñ]/g, (c) => FOLD[c] ?? c)
    .toLowerCase()
    .replace(/[^a-z0-9\s./-]/g, ' ')
    // People write "180g", "200ml", "3kaşık" without a space. Left joined, the
    // unit is invisible to the parser and the quantity gets multiplied by a
    // household measure instead — "180g chicken" became 21.6 kg in testing.
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Light Turkish stemmer.
 *
 * Turkish is agglutinative: "çay", "çayın", "çaydan", "çayları" are all tea,
 * but to a trigram matcher they are four different strings. Without this,
 * "çayın yanında şeker" silently loses the tea — a real failure the eval
 * caught, not a hypothetical one.
 *
 * Deliberately conservative: strips at most ONE suffix, never below a 3-letter
 * stem. Over-stemming would collapse genuinely different foods together, which
 * is a far worse failure than missing an inflection. Operates on already-folded
 * text, so suffixes are listed in their ASCII form.
 */
const TR_SUFFIXES = [
  'lerinden', 'larindan', 'lerini', 'larini', 'lerin', 'larin',
  'ndan', 'nden', 'tan', 'ten', 'dan', 'den', 'lar', 'ler',
  'nin', 'nun', 'sinin', 'si', 'su', 'yi', 'yu', 'ya', 'ye',
  'da', 'de', 'ta', 'te', 'in', 'un', 'i', 'u', 'a', 'e',
].sort((a, b) => b.length - a.length);

export function turkishStem(word: string): string {
  if (word.length < 5) return word;
  for (const suffix of TR_SUFFIXES) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
      return word.slice(0, -suffix.length);
    }
  }
  return word;
}

/**
 * English plural strip. Needed for the same reason as the Turkish stemmer:
 * "eggs" and "egg" are one food, and a trigram matcher does not know that.
 * Skips "ss" endings so "grass"/"glass" survive intact.
 */
export function englishStem(word: string): string {
  if (word.length >= 4 && word.endsWith('s') && !word.endsWith('ss')) {
    return word.endsWith('es') && word.length >= 5 ? word.slice(0, -2) : word.slice(0, -1);
  }
  return word;
}

/** Stems every token of an already-normalised phrase, in both languages. */
export function stemPhrase(normalised: string): string {
  return normalised
    .split(' ')
    .map((w) => turkishStem(englishStem(w)))
    .join(' ');
}

/* ─────────────────────────── quantities ─────────────────────────── */

const NUMBER_WORDS: Record<string, number> = {
  // English
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10, half: 0.5, quarter: 0.25,
  // Turkish
  bir: 1, iki: 2, uc: 3, dort: 4, bes: 5,
  alti: 6, yedi: 7, sekiz: 8, dokuz: 9, on: 10, yarim: 0.5, ceyrek: 0.25,
};

const VAGUE_QUANTIFIERS = [
  'some', 'a few', 'a bit', 'a little', 'a handful', 'handful',
  'biraz', 'birkac', 'bir avuc', 'avuc', 'az', 'bolca',
];

/**
 * Hedges must match whole words, never substrings.
 *
 * Matched as substrings, the Turkish hedge "az" fires inside "bey-az" — so
 * "2 dilim beyaz ekmek" was read as an unquantified amount and silently
 * halved to one slice. Boundaries here are explicit, because `\b` would not
 * help for the multi-word entries and is ASCII-only anyway.
 */
const VAGUE_PATTERN = new RegExp(
  `(?<=^|\\s)(?:${VAGUE_QUANTIFIERS.join('|')})(?=\\s|$)`,
  'u',
);

export interface ParsedQuantity {
  value: number | undefined;
  /** True when the phrase used a hedge word — widens the portion interval. */
  vague: boolean;
}

/**
 * Pulls a numeric quantity out of a phrase.
 * Handles digits ("2", "1.5"), ASCII fractions ("1/2"), and number words in
 * both languages. Returns `vague: true` for hedges like "a handful" so the
 * portion stage can widen the interval instead of inventing precision.
 */
export function parseQuantity(phrase: string): ParsedQuantity {
  // Turkish (and most of Europe) writes decimals with a comma. normalizeText
  // strips commas as punctuation, which would silently turn "1,5 litre" into
  // 1 litre — a 50% error. Rewrite digit-comma-digit before that happens.
  const t = normalizeText(phrase.replace(/(\d),(\d)/g, '$1.$2'));

  // An explicit number outranks a hedge: "biraz 2 elma" states a quantity.
  const fraction = t.match(/(\d+)\s*\/\s*(\d+)/);
  if (fraction) {
    const [, num, den] = fraction;
    const d = Number(den);
    if (d !== 0) return { value: Number(num) / d, vague: false };
  }

  const digits = t.match(/(\d+(?:[.,]\d+)?)/);
  if (digits?.[1]) return { value: Number(digits[1].replace(',', '.')), vague: false };

  // Hedges are checked before number words because several hedge phrases open
  // with one — "bir avuç", "a handful". Reading the leading article as the
  // quantity would turn "a handful of almonds" into exactly one almond.
  if (VAGUE_PATTERN.test(t)) return { value: undefined, vague: true };

  for (const token of t.split(' ')) {
    const word = NUMBER_WORDS[token];
    if (word !== undefined) return { value: word, vague: false };
  }

  return { value: undefined, vague: false };
}

/* ───────────────────────────── units ────────────────────────────── */

/**
 * Surface unit → canonical unit token.
 *
 * Crucially this maps to a UNIT, never to grams. "1 bardak" is 110 g of tea
 * but 200 g of milk — the mass lives in each food's measure table, so the
 * same Turkish word resolves correctly per food instead of via a global
 * average that is wrong for everything.
 */
const UNIT_ALIASES: Record<string, string> = {
  // mass
  g: 'g', gr: 'g', gram: 'g', grams: 'g', gramme: 'g',
  kg: 'kg', kilo: 'kg', kilogram: 'kg',
  oz: 'oz', ounce: 'oz', lb: 'lb', pound: 'lb',
  // volume
  ml: 'ml', mililitre: 'ml', milliliter: 'ml', cc: 'ml',
  l: 'l', lt: 'l', litre: 'l', liter: 'l',
  // household — English
  cup: 'cup', cups: 'cup',
  tbsp: 'tbsp', tablespoon: 'tbsp', tablespoons: 'tbsp',
  tsp: 'tsp', teaspoon: 'tsp', teaspoons: 'tsp',
  slice: 'slice', slices: 'slice',
  piece: 'piece', pieces: 'piece',
  bowl: 'bowl', bowls: 'bowl',
  plate: 'plate', plates: 'plate',
  glass: 'glass', glasses: 'glass',
  can: 'can', cans: 'can', tin: 'can',
  handful: 'handful',
  portion: 'portion', serving: 'portion', servings: 'portion',
  fillet: 'fillet', bar: 'bar', square: 'square', cube: 'cube',
  pot: 'pot', pat: 'pat', drizzle: 'drizzle',
  // household — Turkish
  kasik: 'tbsp', 'yemek kasigi': 'tbsp', 'corba kasigi': 'tbsp',
  // "tatlı kaşığı" is the dessert spoon, and it must be listed in full. Bare
  // "tatlı" was here as a shorthand, which meant the phrase cleaner stripped it
  // as a unit: "tatlı patates" (sweet potato) became "patates", exact-matched
  // the potato row at score 1.0 on the deterministic rung, and never reached
  // the verifier that would have caught it. A confident, reproducible, ~2x
  // energy error on a common food — the exact failure this pipeline exists to
  // prevent, produced by its cheapest tier.
  'cay kasigi': 'tsp', 'tatli kasigi': 'tsp',
  dilim: 'slice', adet: 'piece', tane: 'piece',
  kase: 'bowl', tabak: 'plate', bardak: 'glass',
  kutu: 'can', avuc: 'handful', porsiyon: 'portion',
  kup: 'cube', paket: 'pot', sise: 'glass',
};

/**
 * Adjectives that select a size-named measure row rather than a unit.
 *
 * "half"/"yarım" deliberately live in NUMBER_WORDS instead: they are
 * quantities, not sizes. Listing them in both places double-applies the
 * fraction ("half an avocado" → 0.5 x the 75 g half-measure = 37.5 g).
 */
const SIZE_ALIASES: Record<string, string> = {
  small: 'small', little: 'small', kucuk: 'small',
  medium: 'medium', regular: 'medium', orta: 'medium',
  large: 'large', big: 'large', buyuk: 'large', 'buyuk boy': 'large',
};

export function canonicalUnit(unit: string | undefined): string | undefined {
  if (!unit) return undefined;
  const key = normalizeText(unit);
  return UNIT_ALIASES[key] ?? (key in SIZE_ALIASES ? SIZE_ALIASES[key] : undefined);
}

/** Detects a size word anywhere in a free-text phrase ("büyük boy latte"). */
export function detectSize(phrase: string): string | undefined {
  const t = normalizeText(phrase);
  // Longest first so "buyuk boy" wins over "buyuk".
  const keys = Object.keys(SIZE_ALIASES).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (new RegExp(`\\b${key}\\b`).test(t)) return SIZE_ALIASES[key];
  }
  return undefined;
}

// Type predicates, not plain booleans: a caller that has checked the unit
// should not then have to re-assert that it is defined.
export function isMassUnit(unit: string | undefined): unit is string {
  return unit === 'g' || unit === 'kg' || unit === 'oz' || unit === 'lb';
}

export function isVolumeUnit(unit: string | undefined): unit is string {
  return unit === 'ml' || unit === 'l';
}

/** Convert an explicit mass to grams. */
export function toGrams(value: number, unit: string): number {
  switch (unit) {
    case 'g': return value;
    case 'kg': return value * 1000;
    case 'oz': return value * 28.3495;
    case 'lb': return value * 453.592;
    default: throw new Error(`toGrams called with non-mass unit: ${unit}`);
  }
}

/** Convert an explicit volume to millilitres. */
export function toMillilitres(value: number, unit: string): number {
  switch (unit) {
    case 'ml': return value;
    case 'l': return value * 1000;
    default: throw new Error(`toMillilitres called with non-volume unit: ${unit}`);
  }
}

/* ──────────────────────── phrase preparation ────────────────────── */

/** Words that carry no matching signal and only dilute lexical scores. */
const STOPWORDS = new Set([
  'of', 'with', 'and', 'the', 'a', 'an', 'some', 'my', 'i', 'ate', 'had',
  've', 'ile', 'yaninda', 'uzerine', 'bir', 'biraz',
]);

/**
 * Strips quantity, unit and size tokens from a phrase so the resolver matches
 * on the food itself. "2 dilim tam bugday ekmegi" → "tam bugday ekmegi".
 */
export function foodPhraseOnly(phrase: string): string {
  const tokens = normalizeText(phrase).split(' ');
  const kept = tokens.filter((tok) => {
    if (!tok) return false;
    if (/^\d+([.,/]\d+)?$/.test(tok)) return false;
    if (UNIT_ALIASES[tok]) return false;
    if (SIZE_ALIASES[tok]) return false;
    if (NUMBER_WORDS[tok] !== undefined) return false;
    if (STOPWORDS.has(tok)) return false;
    return true;
  });
  return kept.join(' ').trim() || normalizeText(phrase);
}
