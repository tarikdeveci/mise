import { GoogleGenAI } from '@google/genai';
import type { ExtractionResult, MealInput } from '../../domain/log.js';
import { withRetry } from '../../util/retry.js';
import {
  buildUserPrompt, EXTRACTION_JSON_SCHEMA, EXTRACTION_SYSTEM_PROMPT,
  parseExtraction, PROMPT_VERSION,
} from './prompt.js';
import { ExtractorError, type Extractor } from './types.js';

/**
 * Gemini extractor.
 *
 * This is the default vision path. The reason is measured, not brand loyalty:
 * across published 2026 multimodal benchmarks Gemini holds the widest lead of
 * any current model family on vision and video understanding, at roughly half
 * the token price of the Opus/GPT tier — and vision is the bottleneck stage
 * here. `npm run eval -- --compare` is what should actually settle it, and it
 * will settle it differently as models ship.
 *
 * Model id is configurable because it changes faster than this code does.
 */
const DEFAULT_MODEL = process.env.GEMINI_MODEL ?? 'gemini-3.1-pro-preview';

/** USD per million tokens. Override when the published rate changes. */
const PRICING = {
  inputPerMTok: Number(process.env.GEMINI_INPUT_PRICE ?? 2),
  outputPerMTok: Number(process.env.GEMINI_OUTPUT_PRICE ?? 12),
};

export function createGeminiExtractor(): Extractor {
  const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new ExtractorError('GOOGLE_API_KEY (or GEMINI_API_KEY) is not set', 'gemini', false);
  }

  const ai = new GoogleGenAI({ apiKey });
  let usage: { inputTokens: number; outputTokens: number; costUsd: number } | null = null;

  return {
    id: 'gemini',
    model: DEFAULT_MODEL,
    supportsVision: true,
    promptVersion: PROMPT_VERSION,

    async extract(input: MealInput): Promise<ExtractionResult> {
      const parts: Array<Record<string, unknown>> = [];

      if (input.imageBase64) {
        parts.push({
          inlineData: {
            data: input.imageBase64,
            mimeType: input.imageMediaType ?? 'image/jpeg',
          },
        });
      }
      parts.push({ text: buildUserPrompt(input.text, Boolean(input.imageBase64)) });

      const response = await withRetry(
        () =>
          ai.models.generateContent({
            model: DEFAULT_MODEL,
            contents: [{ role: 'user', parts }],
            config: {
              systemInstruction: EXTRACTION_SYSTEM_PROMPT,
              responseMimeType: 'application/json',
              responseJsonSchema: EXTRACTION_JSON_SCHEMA,
              // Deterministic decoding. Re-scanning the same meal must not
              // produce a different answer — a documented failure of shipped
              // competitors, and one we can simply decline to have.
              temperature: 0,
            },
          }),
        // Vision extraction is the slowest legitimate call in the system, so
        // the ceiling is generous — but it is a ceiling. Without one, a single
        // hung request stalls the meal indefinitely: a photo case was measured
        // taking 623 s against 12-16 s for its neighbours.
        { label: 'gemini.extract', timeoutMs: 30_000 },
      );

      const meta = response.usageMetadata;
      const inputTokens = meta?.promptTokenCount ?? 0;
      const outputTokens = meta?.candidatesTokenCount ?? 0;
      usage = {
        inputTokens,
        outputTokens,
        costUsd:
          (inputTokens / 1e6) * PRICING.inputPerMTok +
          (outputTokens / 1e6) * PRICING.outputPerMTok,
      };

      const text = response.text;
      if (!text) {
        throw new ExtractorError('Gemini returned an empty response', 'gemini', true);
      }
      return parseExtraction(text);
    },

    lastUsage: () => usage,
  };
}
