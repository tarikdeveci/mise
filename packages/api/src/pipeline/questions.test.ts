import { describe, it, expect } from 'vitest';
import { loadFoodDb } from '../data/foodDb.js';
import type { Confidence, FoodCandidate, LoggedItem } from '../domain/log.js';
import { buildQuestions } from './questions.js';

const db = loadFoodDb();

const confidence = (weakest: Confidence['weakest']): Confidence => ({
  overall: 0.6, band: 'medium', extraction: 0.9, resolution: 0.7, portion: 0.7, weakest,
});

function itemWith(args: {
  phrase: string;
  foodId: string | null;
  /** Only the identity question reads these. */
  candidates?: Array<[string, number]>;
  weakest: Confidence['weakest'];
  grams?: number;
}): LoggedItem {
  const food = args.foodId ? db.byId(args.foodId) : undefined;
  const grams = args.grams ?? 100;
  const candidates: FoodCandidate[] = (args.candidates ?? []).map(([foodId, score]) => ({
    foodId, name: db.byId(foodId)?.name ?? foodId, score, via: 'lexical',
  }));

  return {
    id: 'item-1',
    extracted: { phrase: args.phrase, preparation: 'unknown', confidence: 0.9 },
    resolution: {
      method: args.foodId ? 'llm_rerank' : 'unresolved',
      foodId: args.foodId,
      candidates,
      margin: 0.1,
    },
    foodId: args.foodId,
    foodName: food?.name ?? null,
    source: food?.source ?? null,
    portion: food
      ? {
          gramsLikely: grams, gramsMin: grams * 0.7, gramsMax: grams * 1.3,
          basis: 'household_measure', assumption: 'test', fromVision: false,
          method: 'model_estimate',
        }
      : null,
    nutrition: null,
    confidence: confidence(args.weakest),
  };
}

describe('which food did you have', () => {
  /**
   * The reported case, with the scores retrieval actually produced: egg
   * noodles at 0.886, then boiled egg, menemen and fried egg between 0.69 and
   * 0.75 — every one of them reachable only because the Turkish phrase for
   * "with egg" contains the word for egg.
   */
  it('drops candidates too far behind the leader to be contesting anything', () => {
    const [question] = buildQuestions([
      itemWith({
        phrase: 'yumurtalı noodle',
        foodId: 'fdc:169732',
        weakest: 'resolution',
        candidates: [
          ['fdc:169732', 0.886],
          ['fdc:173424', 0.754],
          ['tr:menemen', 0.694],
          ['fdc:173423', 0.692],
        ],
      }),
    ], db);

    expect(question?.options.map((o) => o.foodId)).toEqual(['fdc:169732', 'fdc:173424']);
  });

  it('puts the food already chosen first, so the app can mark it', () => {
    const [question] = buildQuestions([
      itemWith({
        phrase: 'peynir',
        foodId: 'tr:kasar',
        weakest: 'resolution',
        candidates: [['fdc:173420', 0.8], ['tr:kasar', 0.72]],
      }),
    ], db);

    expect(question?.options[0]?.foodId).toBe('tr:kasar');
  });

  it('asks nothing when the only survivor is the answer we already gave', () => {
    // Agreeing with ourselves is not information, and a question with one
    // foregone answer is a tap that buys nothing.
    const questions = buildQuestions([
      itemWith({
        phrase: 'yumurtalı noodle',
        foodId: 'fdc:169732',
        weakest: 'resolution',
        candidates: [['fdc:169732', 0.886], ['tr:menemen', 0.4]],
      }),
    ], db);

    expect(questions).toHaveLength(0);
  });

  it('still asks about an unresolved item with a single strong match', () => {
    // Here "skip" is a usable no, so one option is a real question.
    const [question] = buildQuestions([
      itemWith({
        phrase: 'menemen gibi bir şey',
        foodId: null,
        weakest: 'resolution',
        candidates: [['tr:menemen', 0.78], ['fdc:173423', 0.2]],
      }),
    ], db);

    expect(question?.options).toHaveLength(1);
  });

  /**
   * Measured against the seed: real foods retrieve at 0.727 and up, while
   * words the database has never heard of retrieve at 0.46-0.61 — "kinoa"
   * returns ground beef at 0.556 and milk chocolate at 0.506. Those cleared
   * the old bar of 0.35, so the app asked which kinoa you had and offered
   * beef, chocolate and diet cola as the answers.
   */
  it('admits it does not know rather than offering embedding noise', () => {
    const [question] = buildQuestions([
      itemWith({
        phrase: 'kinoa',
        foodId: null,
        weakest: 'resolution',
        candidates: [['fdc:174032', 0.556], ['fdc:167762', 0.506], ['fdc:174850', 0.503]],
      }),
    ], db);

    expect(question?.options).toEqual([]);
    expect(question?.question).toContain('does not know');
  });

  it('says nothing at all when a resolved item has no offerable rival', () => {
    // Claiming ignorance of a food we just named would be a lie in the other
    // direction, so this item simply carries no question.
    const questions = buildQuestions([
      itemWith({
        phrase: 'bir şey',
        foodId: 'tr:menemen',
        weakest: 'resolution',
        candidates: [['tr:menemen', 0.55], ['fdc:173423', 0.5]],
      }),
    ], db);

    expect(questions).toHaveLength(0);
  });
});

describe('how much of it', () => {
  it('gives a food with one household measure something to choose between', () => {
    // Simit is sold by the piece and nothing else. "1 piece (110 g)" on its
    // own is a question with one answer.
    const [question] = buildQuestions([
      itemWith({ phrase: 'simit', foodId: 'tr:simit', weakest: 'portion', grams: 110 }),
    ], db);

    expect(question?.options.map((o) => o.grams)).toEqual([55, 110, 220]);
    // 330 kcal/100 g across a 165 g span between the smallest and largest.
    expect(question?.expectedKcalSwing).toBeCloseTo(544.5, 1);
  });

  it('does not offer one almond as an answer to how much', () => {
    // Almonds carry a 1.2 g `piece` so "10 badem" converts. It is a unit, not
    // a portion, and it used to sit beside the 28 g handful as an equal choice.
    const [question] = buildQuestions([
      itemWith({ phrase: 'bir avuç badem', foodId: 'fdc:170567', weakest: 'portion', grams: 28 }),
    ], db);

    expect(question?.options.every((o) => (o.grams ?? 0) >= 5)).toBe(true);
    expect(question?.options.map((o) => o.grams)).toEqual([14, 28, 56]);
  });

  it('keeps a sub-portion measure when that is what the person ate', () => {
    // Same food, same table: with the ladder already at one piece, the piece
    // is the sensible answer rather than the discarded one.
    const [question] = buildQuestions([
      itemWith({ phrase: '1 badem', foodId: 'fdc:170567', weakest: 'portion', grams: 1.2 }),
    ], db);

    expect(question?.options.map((o) => o.grams)).toEqual([1.2, 28]);
  });

  it('offers the food\'s own measures when it has several', () => {
    const [question] = buildQuestions([
      itemWith({ phrase: 'noodle', foodId: 'fdc:169732', weakest: 'portion', grams: 160 }),
    ], db);

    expect(question?.options.map((o) => o.grams)).toEqual([160, 220, 320]);
    expect(question?.options[0]?.label).toContain('160 g');
  });
});

describe('ranking', () => {
  it('asks the question worth the most calories first, and at most two', () => {
    const cheap = {
      ...itemWith({ phrase: 'çay', foodId: 'fdc:173227', weakest: 'portion', grams: 110 }),
      id: 'cheap',
    };
    const dear = {
      ...itemWith({ phrase: 'simit', foodId: 'tr:simit', weakest: 'portion', grams: 110 }),
      id: 'dear',
    };
    const also = {
      ...itemWith({ phrase: 'noodle', foodId: 'fdc:169732', weakest: 'portion', grams: 160 }),
      id: 'also',
    };

    const questions = buildQuestions([cheap, dear, also], db);
    expect(questions).toHaveLength(2);
    expect(questions[0]?.itemId).toBe('dear');
  });
});
