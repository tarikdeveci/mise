import type { CanonicalFood } from '../domain/food.js';
import type { ClarificationQuestion, FoodCandidate, LoggedItem } from '../domain/log.js';
import { DECISIVE_MARGIN, SELF_EVIDENT_SCORE } from './resolve/router.js';

/**
 * The clarification questions attached to a meal.
 *
 * Its own module because it is asked twice: once when a meal is logged, and
 * again after every correction — an answered question has to stop being asked,
 * and a question that only becomes worth asking once the item above it is
 * settled has to start. Sharing one implementation is what keeps those two
 * views of the same meal from disagreeing.
 */

/**
 * Below this retrieval score a candidate is not a suggestion, whatever it looks
 * like. It is the resolver's own bar for "close enough to a literal match to
 * take on its own", reused here so the two cannot drift apart.
 *
 * It replaces `MIN_RESOLVABLE_SCORE` (0.35), which was calibrated against the
 * *lexical* scorer and is meaningless against the *vector* one: multilingual
 * embeddings have a high similarity floor, so unrelated short strings sit
 * around 0.45-0.55 and every one of them cleared 0.35. Measured over the seed:
 *
 *   real food      kaşar peyniri 1.000 · ızgara tavuk göğsü 0.759 · süzme peynir 0.727
 *   nothing at all kinoa 0.556 (beef) · kimchi 0.521 (beef) · falafel 0.460 (yogurt)
 *
 * The two groups do not overlap, and 0.72 is the gap. Under the old bar the app
 * answered "which kinoa did you have?" with ground beef, milk chocolate and
 * diet cola — four equal-looking choices, none of them the food, and a tap on
 * any of them would have been recorded as this user's alias for the word.
 */
const OFFERABLE_SCORE = SELF_EVIDENT_SCORE;

/**
 * How many questions one meal may carry.
 *
 * The app asks them one at a time, so this is not a screen-space limit — it is
 * an attention budget. Two is what a person will actually answer before they
 * start tapping through to get rid of the interface.
 */
const MAX_QUESTIONS = 2;

/** An option is only an option if there is something to choose it over. */
const MIN_OPTIONS = 2;

const round = (n: number): number => Number(n.toFixed(1));

/**
 * Builds clarification questions, ranked by how many calories the answer moves.
 *
 * Ranking by kcal swing rather than by confidence is deliberate: being unsure
 * whether the tea glass was 100 ml or 120 ml is not worth a tap, while being
 * unsure whether the potato was boiled or fried is worth several.
 */
/** The question builder only needs lookup, so curated and corpus rows can share it. */
export interface FoodLookup {
  byId(id: string): CanonicalFood | undefined;
}

export function buildQuestions(items: LoggedItem[], db: FoodLookup): ClarificationQuestion[] {
  const questions: ClarificationQuestion[] = [];

  for (const item of items) {
    if (item.confidence.band === 'high') continue;

    if (item.confidence.weakest === 'resolution' || !item.foodId) {
      const q = identityQuestion(item, db);
      if (q) questions.push(q);
      continue;
    }

    if (item.confidence.weakest === 'portion' && item.foodId && item.portion) {
      const food = db.byId(item.foodId);
      if (!food) continue;
      const q = amountQuestion(item, food);
      if (q) questions.push(q);
    }
  }

  return questions.sort((a, b) => b.expectedKcalSwing - a.expectedKcalSwing).slice(0, MAX_QUESTIONS);
}

/**
 * "Which X did you have?"
 *
 * Two gates, and both earn their place by having been absent.
 *
 * `OFFERABLE_SCORE` is the absolute one, and its story is above. The relative
 * one is `DECISIVE_MARGIN`, because clearing an absolute bar does not make a
 * candidate a contender: "yumurtalı noodle" retrieved egg noodles at 0.886 and
 * then boiled egg, menemen and fried egg between 0.69 and 0.75, every one of
 * them reachable only because the Turkish for "with egg" contains the word for
 * egg. A candidate further behind the leader than the resolver's own decisive
 * margin is, by the resolver's definition, not seriously contesting anything,
 * so it has no business being shown as an alternative.
 *
 * What is left is either a real fork — feta at 0.727 against parmesan at 0.715
 * for "süzme peynir" — or nothing, which is its own honest answer.
 */
function identityQuestion(item: LoggedItem, db: FoodLookup): ClarificationQuestion | null {
  const offerable = item.resolution.candidates.filter((c) => c.score >= OFFERABLE_SCORE);
  const best = Math.max(0, ...offerable.map((c) => c.score));
  const serious = offerable.filter((c) => best - c.score <= DECISIVE_MARGIN).slice(0, 4);

  // Nothing we would act on. For an item that never resolved, that IS the
  // answer, and saying so beats inviting a wrong correction. For one that did
  // resolve — a corpus row, say, whose candidates all score below the bar —
  // there is simply nothing to ask, and claiming ignorance of a food we just
  // named would be a lie in the other direction.
  if (serious.length === 0) {
    if (item.foodId) return null;
    return {
      itemId: item.id,
      question: `mise does not know “${item.extracted.phrase}” yet.`,
      options: [],
      // Unknown foods are usually salad leaves and garnishes; the honest
      // ranking is low, not zero, so it never outranks a real ambiguity.
      expectedKcalSwing: 5,
    };
  }

  // A resolved item is asking "is this right", so the current answer belongs in
  // the list — tapping it is a confirmation, and a confirmation is what turns
  // this phrase into a deterministic alias. It goes first, and the app marks it
  // as the one currently chosen. But if it is the ONLY thing standing, there is
  // nothing to ask: an item is not improved by being agreed with.
  //
  // An unresolved item needs no such rule: one candidate is still a real
  // question there, because "skip" is a usable "no".
  if (item.foodId) {
    if (!serious.some((c) => c.foodId !== item.foodId)) return null;
    const at = serious.findIndex((c) => c.foodId === item.foodId);
    if (at > 0) serious.unshift(...serious.splice(at, 1));
    else if (at === -1) serious.unshift(currentAsCandidate(item));
  }

  const options = serious.slice(0, 4).map((c) => ({
    label: db.byId(c.foodId)?.name ?? c.name,
    foodId: c.foodId,
    grams: null,
  }));

  // Corpus rows are not in the curated database and cannot be priced here, so
  // a swing computed over them would be a fabricated zero. Fall back to the
  // same low rank an unknown food gets rather than inventing a number.
  const grams = item.portion?.gramsLikely ?? 100;
  const priced = options
    .map((o) => db.byId(o.foodId)?.per100g.kcal)
    .filter((kcal): kcal is number => kcal !== undefined);

  return {
    itemId: item.id,
    question: `Which “${item.extracted.phrase}” did you have?`,
    options,
    expectedKcalSwing: priced.length >= MIN_OPTIONS
      ? round((Math.max(...priced) - Math.min(...priced)) * grams / 100)
      : 5,
  };
}

/** The item's own answer, for lists that did not retrieve it back. */
function currentAsCandidate(item: LoggedItem): FoodCandidate {
  return {
    foodId: item.foodId ?? '',
    name: item.foodName ?? item.extracted.phrase,
    score: 1,
    via: 'alias',
  };
}

/**
 * Below this share of the amount we already believe, a measure is a unit
 * rather than a serving.
 *
 * Almonds carry a 1.2 g `piece` so that "10 badem" converts; offered as an
 * answer to "how much?" beside a 28 g handful, it reads as the system not
 * knowing what a portion is — and it inflated the question's kcal swing enough
 * to outrank better questions. The seed puts a clean gap here: measured against
 * each food's default portion, secondary measures land at 0.043-0.133 (one
 * almond, a spoon of yogurt, a square of chocolate) and then nothing until
 * 0.331. Any cut inside that gap behaves identically on this data.
 *
 * Anchored on the item's own estimate rather than a constant, so it stays
 * context-sensitive: "bir kare çikolata" makes 6 g the anchor, and the square
 * is then the sensible answer rather than the discarded one. And it only ever
 * trims from below — the large end of a measure table is where the real
 * servings live (a 30 g handful of olives against a 4 g olive).
 */
const SERVING_FLOOR = 0.2;

/**
 * "How much X?"
 *
 * Options are the food's own household measures, in grams, because those are
 * the amounts a person can actually picture. Three failures this shape used to
 * have, all fixed here:
 *
 *  - A food with a single measure produced a question with one answer, which is
 *    not a question. Halving and doubling that measure gives something to
 *    choose between, in the units the food is normally eaten in.
 *  - The swing was quoted from the item's own interval, which describes how
 *    unsure *we* are rather than how far the *answer* can move the number. It
 *    now spans the options actually on offer, so the ranking reflects what the
 *    tap is worth.
 *  - Sub-portion units were offered as portions. See `SERVING_FLOOR`.
 */
function amountQuestion(item: LoggedItem, food: CanonicalFood): ClarificationQuestion | null {
  const options: ClarificationQuestion['options'] = [];
  const seen = new Set<number>();
  const floor = (item.portion?.gramsLikely ?? 0) * SERVING_FLOOR;

  const offer = (label: string, grams: number): void => {
    const g = round(grams);
    if (g <= 0 || seen.has(g)) return;
    seen.add(g);
    options.push({ label: `${label} · ${g} g`, foodId: item.foodId, grams: g });
  };

  for (const measure of food.measures.slice(0, 3)) {
    if (measure.grams < floor) continue;
    offer(`1 ${measure.unit}`, measure.grams);
  }

  // The halving is exempt from the floor: it exists precisely to give a
  // one-measure food a second answer, and filtering it can empty the list.
  const base = food.measures[0];
  if (options.length < MIN_OPTIONS && base) {
    offer(`½ ${base.unit}`, base.grams / 2);
    offer(`2 ${base.unit}`, base.grams * 2);
  }
  if (options.length < MIN_OPTIONS) return null;

  options.sort((a, b) => (a.grams ?? 0) - (b.grams ?? 0));

  const gramsSpan = (options.at(-1)?.grams ?? 0) - (options[0]?.grams ?? 0);

  return {
    itemId: item.id,
    question: `How much ${item.foodName ?? item.extracted.phrase}?`,
    options,
    expectedKcalSwing: round(gramsSpan * food.per100g.kcal / 100),
  };
}
