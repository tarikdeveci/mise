import type {
  Confidence, ConfidenceBand, ExtractedItem, PortionEstimate, Resolution,
} from '../domain/log.js';

/**
 * Confidence scoring.
 *
 * Two design commitments here:
 *
 * 1. **Decomposed, not scalar.** We score each stage separately and keep the
 *    weakest one. A single number tells the user "we're unsure"; the weakest
 *    stage tells us *what to ask about*, which is the difference between a
 *    targeted one-tap question and dumping an edit form on someone.
 *
 * 2. **Calibrated, not asserted.** The weights and band cut-offs below are a
 *    starting point, not truth. `npm run eval` reports a reliability curve and
 *    expected calibration error; when it says items scored 0.8 are right 60%
 *    of the time, these constants are what changes. A confidence number nobody
 *    has checked against outcomes is decoration.
 */

/**
 * Stage weights, chosen by kcal impact rather than intuition.
 * Portion carries the most weight because portion error dominates calorie
 * error; extraction the least because a missed item is usually caught by the
 * user glancing at a three-line list.
 */
const WEIGHTS = { extraction: 0.25, resolution: 0.4, portion: 0.35 } as const;

/** Band cut-offs. Calibrated against the golden set — see eval output. */
export const BANDS = { high: 0.8, medium: 0.55 } as const;

/** How much we trust each resolution rung, before the margin adjustment. */
const METHOD_CEILING: Record<Resolution['method'], number> = {
  user_alias: 1.0,      // this exact user corrected this exact phrase
  global_alias: 0.95,   // a curated decision we can point at
  lexical: 0.92,
  vector: 0.88,
  composite: 0.85,
  llm_rerank: 0.75,     // capped: we only got here because it was contested
  unresolved: 0.0,
};

/**
 * Ceiling for a portion a model read off a photo.
 *
 * Measured, not tuned. The same breakfast photo run four times at temperature
 * zero returned identical foods every time — the resolver is deterministic —
 * but the cheese quantity alternated between two readings, moving the meal
 * between 470 and 866 kcal.
 *
 * The value follows from that observation: the estimate is bimodal, so on any
 * given run it is roughly a coin flip which branch we landed on, and 0.5 is
 * what that is worth. It is deliberately not reverse-engineered to land in a
 * particular band — though it does put a photo portion in `needs a glance`
 * rather than `nothing to check`, which is the only defensible answer for a
 * number that unstable.
 *
 * Text portions are untouched. The eval shows that path is already
 * under-confident, so penalising it would cost coverage and buy nothing.
 */
const VISION_PORTION_CEILING = 0.5;

/** Portion confidence follows directly from how the number was obtained. */
function portionConfidence(portion: PortionEstimate): number {
  const cap = (v: number): number => (portion.fromVision ? Math.min(v, VISION_PORTION_CEILING) : v);
  switch (portion.basis) {
    case 'explicit_mass': return cap(0.98);
    case 'explicit_volume': return cap(0.92);
    case 'household_measure': {
      // Width of the interval IS the uncertainty; derive rather than restate.
      const relWidth = (portion.gramsMax - portion.gramsMin) / (2 * portion.gramsLikely);
      return cap(Math.max(0.4, 1 - relWidth));
    }
    case 'vague_quantifier': return cap(0.45);
    case 'visual_default': return 0.35;
  }
}

function resolutionConfidence(resolution: Resolution, rerankerConfidence?: number): number {
  const ceiling = METHOD_CEILING[resolution.method];
  if (ceiling === 0) return 0;

  if (resolution.method === 'llm_rerank') {
    return Math.min(ceiling, rerankerConfidence ?? 0.6);
  }

  // A decisive margin is what makes a retrieval answer trustworthy; a 0.02 gap
  // between the top two candidates means the winner is nearly arbitrary.
  const marginFactor = Math.min(1, 0.55 + resolution.margin * 2.2);
  return Number((ceiling * marginFactor).toFixed(4));
}

export function bandFor(overall: number): ConfidenceBand {
  if (overall >= BANDS.high) return 'high';
  if (overall >= BANDS.medium) return 'medium';
  return 'low';
}

export function scoreConfidence(args: {
  extracted: ExtractedItem;
  resolution: Resolution;
  portion: PortionEstimate | null;
  rerankerConfidence?: number;
}): Confidence {
  const extraction = Math.max(0, Math.min(1, args.extracted.confidence));
  const resolution = resolutionConfidence(args.resolution, args.rerankerConfidence);
  const portion = args.portion ? portionConfidence(args.portion) : 0;

  // Weighted geometric mean: a zero in any stage zeroes the result, which is
  // the correct semantics. An unresolved food has no meaningful confidence,
  // however certain we are about the portion of it.
  const overall =
    resolution === 0 || portion === 0
      ? 0
      : Number(
          (
            extraction ** WEIGHTS.extraction *
            resolution ** WEIGHTS.resolution *
            portion ** WEIGHTS.portion
          ).toFixed(4),
        );

  const stages: Array<[Confidence['weakest'], number]> = [
    ['extraction', extraction],
    ['resolution', resolution],
    ['portion', portion],
  ];
  const weakest = stages.reduce((lo, cur) => (cur[1] < lo[1] ? cur : lo))[0];

  return { overall, band: bandFor(overall), extraction, resolution, portion, weakest };
}

/**
 * Turns a per-item band into the meal-level disposition.
 *
 * `needs_input` is not a failure state — it is the system declining to guess.
 * The eval measures precision on the auto-logged subset separately from
 * overall accuracy precisely so that this trade-off is explicit and tunable:
 * we can always buy accuracy with coverage, and the right exchange rate is a
 * product decision, not an accident of thresholds.
 */
export function dispositionFor(bands: ConfidenceBand[]): 'confirmed' | 'needs_review' | 'needs_input' {
  if (bands.length === 0) return 'confirmed';
  if (bands.includes('low')) return 'needs_input';
  if (bands.includes('medium')) return 'needs_review';
  return 'confirmed';
}
