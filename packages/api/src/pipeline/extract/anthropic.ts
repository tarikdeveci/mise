import Anthropic from '@anthropic-ai/sdk';
import { ExtractionResult, type MealInput } from '../../domain/log.js';
import { withRetry } from '../../util/retry.js';
import {
  buildUserPrompt, EXTRACTION_JSON_SCHEMA, EXTRACTION_SYSTEM_PROMPT, PROMPT_VERSION,
} from './prompt.js';
import { ExtractorError, type Extractor } from './types.js';

/**
 * Anthropic extractor.
 *
 * Structured output is obtained by forcing a single tool call rather than via
 * the SDK's newer `messages.parse` helper. Two reasons: the tool path is
 * stable across SDK versions (the helper is not present before 0.7x), and it
 * consumes the same hand-written `EXTRACTION_JSON_SCHEMA` as the Gemini and
 * OpenAI adapters — so the bake-off compares models, not three subtly
 * different schema encodings.
 */
const TOOL_NAME = 'record_meal_items';
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-opus-5';

const PRICING = {
  inputPerMTok: Number(process.env.ANTHROPIC_INPUT_PRICE ?? 5),
  outputPerMTok: Number(process.env.ANTHROPIC_OUTPUT_PRICE ?? 25),
};

const MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
type MediaType = (typeof MEDIA_TYPES)[number];

function mediaTypeOf(value: string | undefined): MediaType {
  return MEDIA_TYPES.includes(value as MediaType) ? (value as MediaType) : 'image/jpeg';
}

export function createAnthropicExtractor(): Extractor {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new ExtractorError('ANTHROPIC_API_KEY is not set', 'anthropic', false);

  const client = new Anthropic({ apiKey });
  let usage: { inputTokens: number; outputTokens: number; costUsd: number } | null = null;

  return {
    id: 'anthropic',
    model: DEFAULT_MODEL,
    supportsVision: true,
    promptVersion: PROMPT_VERSION,

    async extract(input: MealInput): Promise<ExtractionResult> {
      const content: Anthropic.ContentBlockParam[] = [];

      if (input.imageBase64) {
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: mediaTypeOf(input.imageMediaType),
            data: input.imageBase64,
          },
        });
      }
      content.push({ type: 'text', text: buildUserPrompt(input.text, Boolean(input.imageBase64)) });

      const response = await withRetry(
        () =>
          client.messages.create({
            model: DEFAULT_MODEL,
            max_tokens: 4096,
            system: EXTRACTION_SYSTEM_PROMPT,
            messages: [{ role: 'user', content }],
            tools: [
              {
                name: TOOL_NAME,
                description: 'Record the food items found in the meal description or photo.',
                input_schema: EXTRACTION_JSON_SCHEMA as unknown as Anthropic.Tool.InputSchema,
              },
            ],
            // Forcing the tool is what makes the response structured: the model
            // has no path to free-form prose, so there is nothing to parse
            // heuristically and nothing to "clean up" if it drifts.
            tool_choice: { type: 'tool', name: TOOL_NAME },
          }),
        { label: 'anthropic.extract' },
      );

      const inputTokens = response.usage.input_tokens;
      const outputTokens = response.usage.output_tokens;
      usage = {
        inputTokens,
        outputTokens,
        costUsd:
          (inputTokens / 1e6) * PRICING.inputPerMTok +
          (outputTokens / 1e6) * PRICING.outputPerMTok,
      };

      const toolUse = response.content.find((b) => b.type === 'tool_use');
      if (!toolUse || toolUse.type !== 'tool_use') {
        throw new ExtractorError('Anthropic did not call the extraction tool', 'anthropic', true);
      }

      // Validate even though the tool schema constrains generation: the schema
      // is the provider's promise, this is our boundary.
      const parsed = ExtractionResult.safeParse(toolUse.input);
      if (!parsed.success) {
        throw new ExtractorError(
          `Anthropic tool input failed validation: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
          'anthropic',
          true,
        );
      }
      return parsed.data;
    },

    lastUsage: () => usage,
  };
}
