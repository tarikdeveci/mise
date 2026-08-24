import type { ExtractionResult, MealInput } from '../../domain/log.js';

/**
 * The extractor boundary.
 *
 * Model choice sits behind this interface on purpose. The case study asks
 * which model is best for food recognition; the honest answer is that it is a
 * measurement, not an opinion — and it changes with every model release. So
 * the architecture refuses to bake one in: every provider implements the same
 * three-method contract, `npm run eval -- --extractor=<id>` runs any of them
 * over the same golden set, and the README publishes the resulting table.
 *
 * Swapping providers is a config change, not a refactor.
 */
export interface Extractor {
  readonly id: string;
  /** Model identifier recorded in each log's provenance, for reproducibility. */
  readonly model: string;
  readonly supportsVision: boolean;
  /** Prompt revision, versioned so an accuracy change can be attributed. */
  readonly promptVersion: string;

  extract(input: MealInput): Promise<ExtractionResult>;

  /** Per-call cost accounting, for the cost-per-log metric. Null if unknown. */
  lastUsage?(): { inputTokens: number; outputTokens: number; costUsd: number } | null;
}

export class ExtractorError extends Error {
  constructor(
    message: string,
    readonly extractorId: string,
    readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ExtractorError';
  }
}
