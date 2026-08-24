import type { CanonicalFood } from '../../domain/food.js';
import type {
  ExtractedItem, PortionEstimate, PortionMethod, ReferenceObject,
} from '../../domain/log.js';
import type { FoodDb } from '../../data/foodDb.js';
import type { AliasStore } from '../resolve/aliasStore.js';

/**
 * The portion ladder.
 *
 * Identifying a food is close to solved; working out how much of it there was
 * is not. Nutrition5k's model scores 9.5% error predicting calories per gram
 * and 26.1% predicting total calories — the same model, three times worse, and
 * the whole difference is portioning. Our own vision path reproduced it: four
 * runs of one photo returned identical foods and a portion that swung 84%.
 *
 * So the answer is not a better estimator. It is to *avoid estimating* whenever
 * something cheaper and more exact can answer instead. Each strategy below is a
 * rung; the ladder stops at the first one that can answer, exactly like the
 * resolver does for identity.
 *
 *   stated mass       user measured it            ~0%
 *   barcode           the label says              ~0%
 *   user memory       they confirmed it before    ~0%
 *   household measure their words + our table     varies by measure
 *   reference object  a card in frame gives scale ~18%
 *   model estimate    last resort                 23-35%
 *
 * The published numbers behind those figures are in the README. What matters
 * architecturally is that the top three cost the user one tap and carry almost
 * no error, and most real logs can reach them.
 */

/** Nutrition facts read off a scanned package. */
export interface BarcodeFacts {
  code: string;
  name: string;
  source: string;
  /** Grams in one labelled serving, when the package states one. */
  servingGrams?: number;
}

export interface PortionContext {
  db: FoodDb;
  food: CanonicalFood;
  item: ExtractedItem;
  userId: string;
  aliases: AliasStore;
  /** True when this item came from a photo rather than typed text. */
  fromImage: boolean;
  /** A scale reference the extractor reported seeing in the frame. */
  reference: ReferenceObject;
  /** Label data, when this item came from a scanned barcode. */
  barcode?: BarcodeFacts;
}

export interface PortionStrategy {
  readonly method: PortionMethod;
  /**
   * Returns an estimate, or null to pass the question down the ladder.
   * A strategy must return null rather than guess: the whole point is that a
   * cheaper rung answering badly is worse than a later rung answering well.
   */
  estimate(ctx: PortionContext): PortionEstimate | null;
}
