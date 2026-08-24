import type { Extractor } from './types.js';
import { createRuleExtractor } from './rules.js';

/**
 * Extractor registry.
 *
 * Providers are loaded lazily so that a missing SDK or an unset API key costs
 * nothing until that extractor is actually requested. The rule tier always
 * works, which keeps `npm test` and the CI regression gate free and offline.
 */
export const EXTRACTOR_IDS = ['rules', 'gemini', 'openai', 'anthropic'] as const;
export type ExtractorId = (typeof EXTRACTOR_IDS)[number];

export function isExtractorId(value: string): value is ExtractorId {
  return (EXTRACTOR_IDS as readonly string[]).includes(value);
}

export async function createExtractor(id: ExtractorId): Promise<Extractor> {
  switch (id) {
    case 'rules':
      return createRuleExtractor();
    case 'gemini': {
      const { createGeminiExtractor } = await import('./gemini.js');
      return createGeminiExtractor();
    }
    case 'openai': {
      const { createOpenAiExtractor } = await import('./openai.js');
      return createOpenAiExtractor();
    }
    case 'anthropic': {
      const { createAnthropicExtractor } = await import('./anthropic.js');
      return createAnthropicExtractor();
    }
  }
}

/** Which extractors have credentials available right now. */
export function availableExtractors(): ExtractorId[] {
  const out: ExtractorId[] = ['rules'];
  if (process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY) out.push('gemini');
  if (process.env.OPENAI_API_KEY) out.push('openai');
  if (process.env.ANTHROPIC_API_KEY) out.push('anthropic');
  return out;
}
