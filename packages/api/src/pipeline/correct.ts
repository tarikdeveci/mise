import { randomUUID } from 'node:crypto';
import type { FoodDb } from '../data/foodDb.js';
import type { CanonicalFood } from '../domain/food.js';
import type {
  ExtractedItem, FoodCandidate, LoggedItem, MealLog, NutritionInterval,
} from '../domain/log.js';
import { dispositionFor, scoreConfidence } from './confidence.js';
import { computeNutrition, sumIntervals, verifyTraceable } from './nutrition.js';
import { estimatePortion, userSetPortion } from './portion/index.js';
import { buildQuestions } from './questions.js';
import type { AliasStore } from './resolve/aliasStore.js';

/**
 * The two edits a person can make to the meal in front of them: change a line
 * that is wrong, and add one that is missing. Both work on the meal in place,
 * and both end at `rebuild`.
 */

/**
 * Applies a user's answer to the meal they are looking at.
 *
 * This exists because the app used to do something else entirely: it recorded
 * the correction as an alias and then **re-logged the meal from scratch**,
 * sending the item phrases back through the pipeline as fresh text. Three
 * things were wrong with that, and all three are what the user actually feels:
 *
 *  - A stated amount cannot be corrected at all. "150 g noodle" pins the
 *    portion ladder to its top rung, so the remembered gram figure is skipped
 *    by design and the number does not move. You change it, nothing happens.
 *  - A photograph is destroyed. Re-logging sends words, so the picture, its
 *    portions and its scale reference are all replaced by whatever the phrases
 *    resolve to on their own.
 *  - Every item gets a new id, so the app loses track of which question it had
 *    just answered and asks the first one again forever. That is why answering
 *    one question made the rest unreachable.
 *
 * Correcting in place fixes all three at once: same meal, same ids, one item
 * recomputed, and the totals, questions and disposition derived again from the
 * result. The alias is still recorded — that is the part that makes the *next*
 * meal better — but it is no longer the mechanism by which *this* one updates.
 */

export interface CorrectionRequest {
  log: MealLog;
  itemId: string;
  /** The food the user picked. The item's current food when they only set an amount. */
  food: CanonicalFood;
  /** An explicit mass. Overrides the ladder outright; see `userSetPortion`. */
  grams?: number;
  db: FoodDb;
  /** Lookup across both the curated seed and the wider reference corpus. */
  foodById?: (id: string) => CanonicalFood | undefined;
  aliases: AliasStore;
  userId: string;
}

export type CorrectionResult =
  | { ok: true; log: MealLog }
  | { ok: false; reason: string };

export function applyCorrection(req: CorrectionRequest): CorrectionResult {
  const { log, itemId, food, grams, db } = req;

  const target = log.items.find((i) => i.id === itemId);
  if (!target) return { ok: false, reason: `No item ${itemId} in meal ${log.id}.` };

  const portion = grams !== undefined
    ? userSetPortion(grams, target.portion?.fromVision ?? false)
    // No mass given: the amount still has to be re-derived, because the words
    // were about the OLD food. "2 dilim" against bread and against cheese are
    // different masses, and keeping the old grams would silently carry one
    // food's measure table onto another.
    : estimatePortion({
        db,
        food,
        item: target.extracted,
        userId: req.userId,
        aliases: req.aliases,
        fromImage: target.portion?.fromVision ?? false,
        reference: 'none',
      });

  const nutrition = computeNutrition(food, portion);

  // The same assertion the pipeline runs. A correction is still a path that
  // produces a displayed number, and it is not exempt from having to prove
  // that number came from a database row.
  const traceable = verifyTraceable(food, portion, nutrition);
  if (!traceable.ok) return { ok: false, reason: traceable.reason };

  const resolution = {
    // The person who ate it told us. There is no stronger evidence available,
    // and it is the same rung a replayed correction lands on next time.
    method: 'user_alias' as const,
    foodId: food.id,
    candidates: withChosenFirst(target.resolution.candidates, food),
    margin: 1,
  };

  const corrected: LoggedItem = {
    ...target,
    resolution,
    foodId: food.id,
    foodName: food.name,
    source: food.source,
    portion,
    nutrition,
    confidence: scoreConfidence({ extracted: target.extracted, resolution, portion }),
  };

  // Items are replaced, never merged. Merging repeats is right when a meal is
  // first read, but doing it here would destroy the id of a line the app is
  // mid-conversation about — which is the bug this whole path exists to fix.
  const items = log.items.map((i) => (i.id === itemId ? corrected : i));

  return { ok: true, log: rebuild(log, items, db, req.foodById) };
}

/* ─────────────────────────── adding a line ─────────────────────────── */

export interface AdditionRequest {
  log: MealLog;
  /** The verified row the user picked out of search. */
  food: CanonicalFood;
  /** What they called it. The food's own name when they did not say. */
  phrase?: string;
  /** An explicit mass. Without one the amount comes off the ladder as usual. */
  grams?: number;
  db: FoodDb;
  /** Lookup across both the curated seed and the wider reference corpus. */
  foodById?: (id: string) => CanonicalFood | undefined;
  aliases: AliasStore;
  userId: string;
}

export type AdditionResult =
  | { ok: true; log: MealLog; itemId: string }
  | { ok: false; reason: string };

/**
 * Adds a food the extractor never produced.
 *
 * Correction can only edit lines that already exist, so a plate read as four
 * items when there were five had no repair at all. The missing food was not
 * wrong, it was absent: there was nothing to tap, no candidate list to pick
 * from, and no question about it to answer. The only way to record it was to
 * log the whole meal again — which throws away the photograph, the item ids
 * the app is mid-question about, and every correction already made to it.
 *
 * The new line is held to the rules an extracted one is held to. Its amount
 * comes off the same ladder, its nutrition is computed from the chosen row,
 * and the traceability assertion runs: a food the user added is still a number
 * the app displays, and it does not get to skip proving where it came from.
 */
export function addItem(req: AdditionRequest): AdditionResult {
  const { log, food, grams, db } = req;

  // Their wording, when they gave one. It is what the alias is keyed on, what
  // the line reads as, and what a gap row reads back as later.
  const phrase = req.phrase?.trim() || food.name;

  const extracted: ExtractedItem = {
    phrase,
    preparation: 'unknown',
    // Not a model's certainty that the food is on the plate — the person who
    // ate it saying it was. Nothing weaker is available to read this as.
    confidence: 1,
  };

  const portion = grams !== undefined
    ? userSetPortion(grams)
    : estimatePortion({
        db,
        food,
        item: extracted,
        userId: req.userId,
        aliases: req.aliases,
        // Typed, not seen. This line came from a text field even when the rest
        // of the meal came off a photograph, and inheriting the photo's
        // uncertainty would overstate the spread on the one item we were told.
        fromImage: false,
        reference: 'none',
      });

  const nutrition = computeNutrition(food, portion);

  const traceable = verifyTraceable(food, portion, nutrition);
  if (!traceable.ok) return { ok: false, reason: traceable.reason };

  const resolution = {
    method: 'user_alias' as const,
    foodId: food.id,
    // No shortlist, because retrieval was never asked. Recording the chosen
    // row as the only candidate keeps the trace honest about that; an empty
    // list would read as "nothing was close" rather than "nothing was run".
    candidates: [{ foodId: food.id, name: food.name, score: 1, via: 'alias' as const }],
    margin: 1,
  };

  const item: LoggedItem = {
    id: randomUUID(),
    extracted,
    resolution,
    foodId: food.id,
    foodName: food.name,
    source: food.source,
    portion,
    nutrition,
    confidence: scoreConfidence({ extracted, resolution, portion }),
  };

  // Appended, never merged into a line that resolved to the same food. Adding
  // a second coffee is somebody telling us there were two; folding it into the
  // first would answer that by moving a number they did not touch, on a line
  // the app may be mid-question about. Same reasoning as the replacement above.
  return { ok: true, log: rebuild(log, [...log.items, item], db, req.foodById), itemId: item.id };
}

/**
 * The meal, derived again from its items.
 *
 * Shared by both edits deliberately. Totals, questions and disposition are all
 * functions of the item list, and keeping two copies of that derivation is two
 * chances for a corrected meal and an extended one to disagree about the same
 * items — the drift `buildQuestions` exists as a single module to prevent.
 */
function rebuild(
  log: MealLog,
  items: LoggedItem[],
  db: FoodDb,
  foodById?: (id: string) => CanonicalFood | undefined,
): MealLog {
  return {
    ...log,
    items,
    totals: sumIntervals(
      items.map((i) => i.nutrition).filter((n): n is NutritionInterval => n !== null),
    ),
    questions: buildQuestions(items, { byId: (id) => db.byId(id) ?? foodById?.(id) }),
    status: dispositionFor(items.map((i) => i.confidence.band)),
  };
}

/**
 * Keeps the alternatives the resolver considered, with the chosen food at the
 * front. The user may want to change their mind, and the list of what was
 * nearly picked is the honest place to change it back from.
 */
function withChosenFirst(candidates: FoodCandidate[], food: CanonicalFood): FoodCandidate[] {
  const rest = candidates.filter((c) => c.foodId !== food.id);
  return [{ foodId: food.id, name: food.name, score: 1, via: 'alias' as const }, ...rest].slice(0, 6);
}
