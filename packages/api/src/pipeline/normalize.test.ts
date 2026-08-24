import { describe, it, expect } from 'vitest';
import {
  normalizeText, parseQuantity, canonicalUnit, detectSize,
  toGrams, toMillilitres, foodPhraseOnly,
} from './normalize.js';

describe('normalizeText', () => {
  it('folds Turkish diacritics so users can type either spelling', () => {
    expect(normalizeText('Kaşar')).toBe('kasar');
    expect(normalizeText('kasar')).toBe('kasar');
    expect(normalizeText('ÇİĞ PİRİNÇ')).toBe('cig pirinc');
    expect(normalizeText('Yoğurt')).toBe('yogurt');
  });

  it('collapses punctuation and whitespace', () => {
    expect(normalizeText('  2 dilim  ekmek,  peynir!  ')).toBe('2 dilim ekmek peynir');
  });

  it('separates a number from a unit written without a space', () => {
    // Regression: "180g" parsed as one token meant the unit was invisible and
    // the quantity was multiplied by a household measure — 180 x 120 g = 21.6 kg
    // of chicken, reported as 35,640 kcal.
    expect(normalizeText('180g')).toBe('180 g');
    expect(normalizeText('200ml whole milk')).toBe('200 ml whole milk');
    expect(normalizeText('3kaşık')).toBe('3 kasik');
  });

  it('keeps digits, dots and slashes so quantities survive', () => {
    expect(normalizeText('1/2 avocado')).toBe('1/2 avocado');
    expect(normalizeText('13.5 g')).toBe('13.5 g');
  });
});

describe('parseQuantity', () => {
  it('reads digits', () => {
    expect(parseQuantity('2 slices')).toEqual({ value: 2, vague: false });
    expect(parseQuantity('1.5 cups')).toEqual({ value: 1.5, vague: false });
  });

  it('reads decimal commas', () => {
    expect(parseQuantity('1,5 litre')).toEqual({ value: 1.5, vague: false });
  });

  it('reads ASCII fractions', () => {
    expect(parseQuantity('1/2 avocado')).toEqual({ value: 0.5, vague: false });
  });

  it('reads number words in both languages', () => {
    expect(parseQuantity('two eggs')).toEqual({ value: 2, vague: false });
    expect(parseQuantity('iki yumurta')).toEqual({ value: 2, vague: false });
    expect(parseQuantity('yarım avokado')).toEqual({ value: 0.5, vague: false });
  });

  it('flags hedges as vague instead of guessing a number', () => {
    expect(parseQuantity('bir avuç badem')).toEqual({ value: undefined, vague: true });
    expect(parseQuantity('a handful of almonds')).toEqual({ value: undefined, vague: true });
    expect(parseQuantity('biraz patates')).toEqual({ value: undefined, vague: true });
  });

  it('matches hedges as whole words, not substrings', () => {
    // Regression: the Turkish hedge "az" matched inside "bey-az", so
    // "2 dilim beyaz ekmek" lost its quantity and logged one slice, not two.
    expect(parseQuantity('2 dilim beyaz ekmek')).toEqual({ value: 2, vague: false });
    expect(parseQuantity('beyaz peynir')).toEqual({ value: undefined, vague: false });
    expect(parseQuantity('az şeker')).toEqual({ value: undefined, vague: true });
  });

  it('lets an explicit number outrank a hedge', () => {
    expect(parseQuantity('biraz 2 elma')).toEqual({ value: 2, vague: false });
  });

  it('does not divide by zero on malformed fractions', () => {
    expect(parseQuantity('1/0 thing')).toEqual({ value: 1, vague: false });
  });
});

describe('canonicalUnit', () => {
  it('maps Turkish household units', () => {
    expect(canonicalUnit('kaşık')).toBe('tbsp');
    expect(canonicalUnit('çay kaşığı')).toBe('tsp');
    expect(canonicalUnit('dilim')).toBe('slice');
    expect(canonicalUnit('bardak')).toBe('glass');
    expect(canonicalUnit('kase')).toBe('bowl');
    expect(canonicalUnit('tabak')).toBe('plate');
    expect(canonicalUnit('kutu')).toBe('can');
    expect(canonicalUnit('adet')).toBe('piece');
    expect(canonicalUnit('küp')).toBe('cube');
  });

  it('maps English units and plurals', () => {
    expect(canonicalUnit('tablespoons')).toBe('tbsp');
    expect(canonicalUnit('slices')).toBe('slice');
    expect(canonicalUnit('grams')).toBe('g');
  });

  it('returns undefined for unknown units rather than guessing', () => {
    expect(canonicalUnit('sackful')).toBeUndefined();
    expect(canonicalUnit(undefined)).toBeUndefined();
  });
});

describe('detectSize', () => {
  it('finds size adjectives inside a phrase', () => {
    expect(detectSize('büyük boy latte')).toBe('large');
    expect(detectSize('patates kızartması büyük boy')).toBe('large');
    expect(detectSize('1 medium apple')).toBe('medium');
    expect(detectSize('küçük porsiyon')).toBe('small');
  });

  it('prefers the longer match', () => {
    expect(detectSize('buyuk boy')).toBe('large');
  });

  it('returns undefined when no size is stated', () => {
    expect(detectSize('yogurt')).toBeUndefined();
  });
});

describe('unit conversion', () => {
  it('converts mass units to grams', () => {
    expect(toGrams(1, 'kg')).toBe(1000);
    expect(toGrams(2, 'g')).toBe(2);
    expect(toGrams(1, 'oz')).toBeCloseTo(28.35, 1);
  });

  it('converts volume units to millilitres', () => {
    expect(toMillilitres(1, 'l')).toBe(1000);
    expect(toMillilitres(200, 'ml')).toBe(200);
  });

  it('refuses to silently mix mass and volume', () => {
    expect(() => toGrams(1, 'ml')).toThrow(/non-mass/);
    expect(() => toMillilitres(1, 'g')).toThrow(/non-volume/);
  });
});

describe('foodPhraseOnly', () => {
  it('strips quantity, unit and size tokens', () => {
    expect(foodPhraseOnly('2 dilim tam buğday ekmeği')).toBe('tam bugday ekmegi');
    // "180g" splits into number + unit, so both are stripped as quantity.
    expect(foodPhraseOnly('180g grilled chicken breast')).toBe('grilled chicken breast');
    expect(foodPhraseOnly('1 medium apple')).toBe('apple');
    expect(foodPhraseOnly('3 kaşık zeytinyağı')).toBe('zeytinyagi');
  });

  it('never returns an empty string', () => {
    expect(foodPhraseOnly('2 dilim')).toBe('2 dilim');
    expect(foodPhraseOnly('   ')).toBe('');
  });
});
