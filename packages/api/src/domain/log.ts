import { z } from 'zod';
import { NutrientsPer100g } from './food.js';

/* ────────────────────────────── input ────────────────────────────── */

export const MealInput = z
  .object({
    /** Free text as typed or dictated: "2 dilim ekmek, yanında peynir ve çay". */
    text: z.string().max(2000).optional(),
    /** Base64 image, or a reference to one already uploaded. */
    imageBase64: z.string().optional(),
    imageMediaType: z.enum(['image/jpeg', 'image/png', 'image/webp']).optional(),
    /** BCP-47 hint. We detect anyway; this just breaks ties. */
    locale: z.string().default('tr-TR'),
    /** Local wall-clock time of the meal, used only for meal-slot heuristics. */
    eatenAt: z.string().datetime().optional(),
  })
  .refine((v) => Boolean(v.text?.trim()) || Boolean(v.imageBase64), {
    message: 'Provide at least one of `text` or `imageBase64`.',
  });
export type MealInput = z.infer<typeof MealInput>;

/* ──────────────────────────── extraction ─────────────────────────── */

/**
 * What a vision/text model is allowed to produce. Note what is ABSENT:
 * no kcal, no macros, no food IDs. The model describes what it sees; it does
 * not get to author nutrition facts or invent database keys.
 *
 * This schema is the anti-hallucination boundary. It is enforced by the
 * provider's structured-output mode, not by asking the model nicely.
 */
export const ExtractedItem = z.object({
  /** Verbatim-ish food phrase, e.g. "grilled chicken thigh". */
  phrase: z.string().min(1).max(120),
  /** Numeric quantity if stated or visually estimable. */
  quantity: z.number().positive().optional(),
  /** Unit token as understood: "g", "ml", "slice", "cup", "medium", "plate". */
  unit: z.string().max(30).optional(),
  /** Preparation, when visible or stated. Drives the raw/fried kcal split. */
  preparation: z.enum(['raw', 'cooked', 'fried', 'grilled', 'boiled', 'baked', 'unknown']).default('unknown'),
  /** Brand, only if legible on packaging. Never guessed. */
  brand: z.string().max(60).optional(),
  /** Model's own certainty that this item is present at all. 0..1 */
  confidence: z.number().min(0).max(1),
});
export type ExtractedItem = z.infer<typeof ExtractedItem>;

export const ExtractionResult = z.object({
  items: z.array(ExtractedItem).max(30),
  /** Set when the input plainly isn't food — we refuse rather than guess. */
  notFood: z.boolean().default(false),
  /** Free-text note surfaced to the user for genuinely unusual inputs. */
  note: z.string().max(300).optional(),
});
export type ExtractionResult = z.infer<typeof ExtractionResult>;

/* ──────────────────────────── resolution ─────────────────────────── */

/** How a phrase became a canonical food. Recorded per item, shown in the UI. */
export const ResolutionMethod = z.enum([
  'user_alias',   // this user corrected this phrase before — deterministic replay
  'global_alias', // curated alias table hit
  'lexical',      // trigram/token match, decisive margin
  'vector',       // embedding nearest-neighbour, decisive margin
  'llm_rerank',   // ambiguous: model chose from a closed candidate list
  'composite',    // decomposed into ingredient template
  'unresolved',   // nothing crossed the bar — ask the user
]);
export type ResolutionMethod = z.infer<typeof ResolutionMethod>;

export const FoodCandidate = z.object({
  foodId: z.string(),
  name: z.string(),
  /** 0..1 blended retrieval score. */
  score: z.number(),
  via: z.enum(['lexical', 'vector', 'alias']),
});
export type FoodCandidate = z.infer<typeof FoodCandidate>;

export const Resolution = z.object({
  method: ResolutionMethod,
  foodId: z.string().nullable(),
  /** Top-N candidates considered, kept for the debug trace and error analysis. */
  candidates: z.array(FoodCandidate),
  /**
   * Gap between the best and second-best candidate. This is the single most
   * useful ambiguity signal we have: a large margin means "obvious", a small
   * margin means "two foods look equally likely" — which is exactly when a
   * model reranker earns its cost, and when the user is worth interrupting.
   */
  margin: z.number(),
});
export type Resolution = z.infer<typeof Resolution>;

/* ───────────────────────────── portion ───────────────────────────── */

/**
 * Portion as a DISTRIBUTION, not a point.
 *
 * Nutrition5k found trained dietitians average ~41% error estimating portions
 * from images. Any single gram figure we print is therefore false precision;
 * carrying min/likely/max lets us show an honest kcal interval downstream.
 */
export const PortionEstimate = z.object({
  gramsLikely: z.number().positive(),
  gramsMin: z.number().positive(),
  gramsMax: z.number().positive(),
  basis: z.enum([
    'explicit_mass',      // "180g chicken" — user told us, spread ~0
    'explicit_volume',    // "200ml milk" via density
    'household_measure',  // "2 slices" via the food's measure table
    'vague_quantifier',   // "a handful", "some" — wide spread
    'visual_default',     // photo with no stated quantity — widest spread
  ]),
  /** Human-readable assumption, shown in the UI: "assumed 1 medium ≈ 180 g". */
  assumption: z.string(),
  /**
   * True when the quantity came from a model looking at a photo rather than
   * from something the user wrote. Measured to be far less stable, so it is
   * tracked explicitly instead of being inferred from `basis`.
   */
  fromVision: z.boolean().default(false),
});
export type PortionEstimate = z.infer<typeof PortionEstimate>;

/* ──────────────────────────── confidence ─────────────────────────── */

export const ConfidenceBand = z.enum(['high', 'medium', 'low']);
export type ConfidenceBand = z.infer<typeof ConfidenceBand>;

/**
 * Confidence is decomposed so that a low score is actionable: we know WHICH
 * stage was unsure, which lets us ask one targeted question instead of
 * dumping a full edit form on the user.
 */
export const Confidence = z.object({
  overall: z.number().min(0).max(1),
  band: ConfidenceBand,
  extraction: z.number().min(0).max(1),
  resolution: z.number().min(0).max(1),
  portion: z.number().min(0).max(1),
  /** Which stage dragged the score down — drives the clarification question. */
  weakest: z.enum(['extraction', 'resolution', 'portion']),
});
export type Confidence = z.infer<typeof Confidence>;

/* ───────────────────────────── output ────────────────────────────── */

export const NutritionInterval = z.object({
  likely: NutrientsPer100g,
  min: NutrientsPer100g,
  max: NutrientsPer100g,
});
export type NutritionInterval = z.infer<typeof NutritionInterval>;

export const LoggedItem = z.object({
  id: z.string(),
  extracted: ExtractedItem,
  resolution: Resolution,
  /** Null when unresolved — the item is logged as "needs your input", not dropped. */
  foodId: z.string().nullable(),
  foodName: z.string().nullable(),
  /** Provenance for every number shown. Tappable in the UI. */
  source: z.string().nullable(),
  portion: PortionEstimate.nullable(),
  nutrition: NutritionInterval.nullable(),
  confidence: Confidence,
});
export type LoggedItem = z.infer<typeof LoggedItem>;

export const ClarificationQuestion = z.object({
  itemId: z.string(),
  /** One question, not a form. "Was the yogurt plain or fruit?" */
  question: z.string(),
  options: z.array(z.object({ label: z.string(), foodId: z.string().nullable(), grams: z.number().nullable() })),
  /** Expected error reduction if answered, in kcal. Used to rank questions. */
  expectedKcalSwing: z.number(),
});
export type ClarificationQuestion = z.infer<typeof ClarificationQuestion>;

export const MealLogStatus = z.enum(['confirmed', 'needs_review', 'needs_input']);
export type MealLogStatus = z.infer<typeof MealLogStatus>;

export const MealLog = z.object({
  id: z.string(),
  status: MealLogStatus,
  items: z.array(LoggedItem),
  totals: NutritionInterval,
  /** At most one or two — we interrupt sparingly, ranked by kcal swing. */
  questions: z.array(ClarificationQuestion),
  /** Everything needed to reproduce this exact result. */
  provenance: z.object({
    pipelineVersion: z.string(),
    promptVersion: z.string(),
    extractorId: z.string(),
    model: z.string(),
    traceId: z.string(),
    latencyMs: z.number(),
  }),
  createdAt: z.string(),
});
export type MealLog = z.infer<typeof MealLog>;
