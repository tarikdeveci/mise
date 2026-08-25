import type { ExtractionResult, MealInput } from '../../domain/log.js';
import { logger } from '../../obs/logger.js';
import { metrics } from '../../obs/metrics.js';
import { createRuleExtractor } from './rules.js';
import type { Extractor } from './types.js';

/**
 * The configured model could not read a photo and there is no text that the
 * deterministic tier can use instead. This is an upstream capability outage,
 * not an unknown server bug, so the HTTP layer can give the user a useful exit.
 */
export class VisionExtractionUnavailable extends Error {
  constructor(options?: { cause?: unknown }) {
    super('Photo analysis is temporarily unavailable.', options);
    this.name = 'VisionExtractionUnavailable';
  }
}

/**
 * Wraps a model-backed extractor with the deterministic rule tier.
 *
 * When a provider is down, rate-limited, or returns something the schema
 * rejects, the choice is between failing the request and logging the meal with
 * a worse extractor. For a food diary the second is plainly better: text
 * logging keeps working, and the user sees "worth a look" instead of an error
 * they can do nothing about.
 *
 * Two honesty constraints on the fallback:
 *
 *  - It cannot read photos. A photo-only request has nothing to fall back TO,
 *    so it fails properly rather than returning a confident empty log.
 *  - Every item it produces is confidence-capped, so a degraded read is routed
 *    to review rather than silently auto-accepted. The provenance still says
 *    `rules-v1`, so the log records what actually happened.
 */
export function withRuleFallback(primary: Extractor): Extractor {
  const rules = createRuleExtractor();
  /** Ceiling applied to fallback items, keeping them out of the `high` band. */
  const DEGRADED_CEILING = 0.6;

  return {
    id: `${primary.id}+fallback`,
    model: primary.model,
    supportsVision: primary.supportsVision,
    promptVersion: primary.promptVersion,

    async extract(input: MealInput): Promise<ExtractionResult> {
      try {
        return await primary.extract(input);
      } catch (err) {
        metrics.inc('extractor_fallback_total', { primary: primary.id });

        if (!input.text?.trim()) {
          // Nothing to degrade to. Surfacing the real error beats inventing an
          // empty meal that the user would have to notice was wrong.
          logger.error({ err, extractor: primary.id }, 'extractor failed and no text to fall back on');
          throw new VisionExtractionUnavailable({ cause: err });
        }

        logger.warn(
          { err: String(err).slice(0, 200), extractor: primary.id },
          'extractor failed, degrading to rule tier',
        );

        const result = await rules.extract({ ...input, imageBase64: undefined });
        return {
          ...result,
          items: result.items.map((item) => ({
            ...item,
            confidence: Math.min(item.confidence, DEGRADED_CEILING),
          })),
          note: result.note ?? 'Read without the model — check these before trusting them.',
        };
      }
    },

    lastUsage: () => primary.lastUsage?.() ?? null,
  };
}
