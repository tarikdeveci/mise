import { describe, it, expect } from 'vitest';
import type { ExtractionResult, MealInput } from '../../domain/log.js';
import { withRuleFallback } from './fallback.js';
import { ExtractorError, type Extractor } from './types.js';

function brokenExtractor(err: unknown): Extractor {
  return {
    id: 'broken',
    model: 'test-model',
    supportsVision: true,
    promptVersion: 'test',
    extract: (): Promise<ExtractionResult> => Promise.reject(err),
    lastUsage: () => null,
  };
}

function workingExtractor(result: ExtractionResult): Extractor {
  return {
    id: 'working',
    model: 'test-model',
    supportsVision: true,
    promptVersion: 'test',
    extract: () => Promise.resolve(result),
    lastUsage: () => null,
  };
}

const textInput: MealInput = { text: '2 dilim ekmek ve çay', locale: 'tr-TR' };

describe('rule fallback', () => {
  it('passes through when the primary works', async () => {
    const expected: ExtractionResult = {
      items: [{ phrase: 'muz', preparation: 'unknown', confidence: 0.95 }],
      notFood: false,
    };
    const out = await withRuleFallback(workingExtractor(expected)).extract(textInput);
    expect(out.items[0]?.confidence).toBe(0.95);
  });

  it('degrades to the rule tier when the provider fails', async () => {
    const out = await withRuleFallback(brokenExtractor(new Error('503 upstream'))).extract(textInput);
    expect(out.items.length).toBeGreaterThan(0);
    expect(out.note).toMatch(/without the model/i);
  });

  it('caps degraded confidence so a fallback read is never auto-accepted', async () => {
    const out = await withRuleFallback(brokenExtractor(new Error('boom'))).extract(textInput);
    for (const item of out.items) expect(item.confidence).toBeLessThanOrEqual(0.6);
  });

  it('fails properly on a photo-only request rather than inventing an empty meal', async () => {
    const err = new ExtractorError('provider down', 'broken', true);
    await expect(
      withRuleFallback(brokenExtractor(err)).extract({ imageBase64: 'abc', locale: 'tr-TR' }),
    ).rejects.toThrow('provider down');
  });

  it('does not wrap the id in a way that hides which model was configured', () => {
    const wrapped = withRuleFallback(brokenExtractor(new Error('x')));
    expect(wrapped.id).toContain('broken');
    expect(wrapped.model).toBe('test-model');
  });
});
