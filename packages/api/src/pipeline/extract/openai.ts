import OpenAI from 'openai';
import type { ExtractionResult, MealInput } from '../../domain/log.js';
import { withRetry } from '../../util/retry.js';
import {
  buildUserPrompt, EXTRACTION_JSON_SCHEMA, EXTRACTION_SYSTEM_PROMPT,
  parseExtraction, PROMPT_VERSION,
} from './prompt.js';
import { ExtractorError, type Extractor } from './types.js';

/**
 * OpenAI extractor.
 *
 * Included in the bake-off because published comparisons put its structured
 * output and tool-call reliability ahead of the field, which matters more in a
 * multi-stage pipeline than a single benchmark point: per-call success rates
 * compound, so a few points of schema-adherence advantage is worth measuring
 * separately from raw vision quality.
 */
const DEFAULT_MODEL = process.env.OPENAI_MODEL ?? 'gpt-5.2';

const PRICING = {
  inputPerMTok: Number(process.env.OPENAI_INPUT_PRICE ?? 5),
  outputPerMTok: Number(process.env.OPENAI_OUTPUT_PRICE ?? 30),
};

export function createOpenAiExtractor(): Extractor {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new ExtractorError('OPENAI_API_KEY is not set', 'openai', false);

  const client = new OpenAI({ apiKey });
  let usage: { inputTokens: number; outputTokens: number; costUsd: number } | null = null;

  return {
    id: 'openai',
    model: DEFAULT_MODEL,
    supportsVision: true,
    promptVersion: PROMPT_VERSION,

    async extract(input: MealInput): Promise<ExtractionResult> {
      const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];

      if (input.imageBase64) {
        content.push({
          type: 'image_url',
          image_url: {
            url: `data:${input.imageMediaType ?? 'image/jpeg'};base64,${input.imageBase64}`,
            detail: 'high',
          },
        });
      }
      content.push({ type: 'text', text: buildUserPrompt(input.text, Boolean(input.imageBase64)) });

      const response = await withRetry(
        () =>
          client.chat.completions.create({
            model: DEFAULT_MODEL,
            messages: [
              { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
              { role: 'user', content },
            ],
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: 'meal_extraction',
                schema: EXTRACTION_JSON_SCHEMA as unknown as Record<string, unknown>,
                strict: true,
              },
            },
            temperature: 0,
          }),
        { label: 'openai.extract', timeoutMs: 30_000 },
      );

      const inputTokens = response.usage?.prompt_tokens ?? 0;
      const outputTokens = response.usage?.completion_tokens ?? 0;
      usage = {
        inputTokens,
        outputTokens,
        costUsd:
          (inputTokens / 1e6) * PRICING.inputPerMTok +
          (outputTokens / 1e6) * PRICING.outputPerMTok,
      };

      const text = response.choices[0]?.message.content;
      if (!text) throw new ExtractorError('OpenAI returned an empty response', 'openai', true);
      return parseExtraction(text);
    },

    lastUsage: () => usage,
  };
}
