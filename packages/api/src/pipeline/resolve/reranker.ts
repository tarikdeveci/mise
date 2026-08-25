import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { logger } from '../../obs/logger.js';
import { metrics } from '../../obs/metrics.js';
import { retryableExceptHang, withRetry } from '../../util/retry.js';
import type { Reranker } from './router.js';

/**
 * The closed-candidate verifier.
 *
 * Retrieval always returns *something*, and a decisive margin only says the
 * winner beat the runner-up — not that the winner is right. Running real meal
 * photographs surfaced exactly that gap: "sesame seeds" resolved to tahini
 * (sesame paste) with no contest at all, and became the only item logged for a
 * large bowl of noodles; "spinach and cheese filling" resolved to börek, which
 * is a pastry.
 *
 * So a model is asked one narrow question — is this candidate genuinely the
 * same food as the phrase — and is given three ways to answer: yes, no, or
 * pick a different one from the list. It cannot introduce a food, because the
 * schema constrains the id to the candidates it was handed, and the router
 * drops anything outside that set regardless.
 *
 * This is the fifth rung of the resolution ladder. It is deliberately the last
 * one: it costs a network call and a second of latency, so it only runs where
 * the cheap deterministic rungs have already declined to be confident.
 */

const DEFAULT_MODEL = process.env.RERANK_MODEL ?? process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';

const Verdict = z.object({
  /** Index into the candidate list, or -1 for "none of these is that food". */
  choice: z.number().int().min(-1),
  confidence: z.number().min(0).max(1),
  /** One short clause, kept for the debug trace. */
  because: z.string().max(160).optional(),
});

const SCHEMA = {
  type: 'object',
  properties: {
    choice: {
      type: 'integer',
      description: 'Index of the candidate that is the same food, or -1 if none of them is.',
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    because: { type: 'string', description: 'One short clause explaining the choice.' },
  },
  required: ['choice', 'confidence'],
  additionalProperties: false,
} as const;

const SYSTEM = `You decide whether a food phrase and a database entry are the same food.

You are given a phrase a person used and a short numbered list of candidate
database entries. Reply with the index of the entry that is genuinely the same
food, or -1 if none of them is.

Say -1 rather than settle. These are the mistakes that matter, and they all
look like plausible matches:
  - an ingredient against a product made from it (sesame seeds are not tahini)
  - a filling against a dish that contains something similar (a ricotta filling
    is not a cheese pastry)
  - a different raw material cooked the same way (sweet potato fries are not
    potato fries; they differ by half the energy)
  - a different cut or grind of the same animal (steak is not ground beef)
  - a garnish against a bulk ingredient

Accept a candidate when it is the same food eaten the same way, even if the
wording differs or one side is more specific. Reject when the energy per gram
would be materially different.

Report your genuine certainty. A hedged yes is worse than an honest -1: an
unmatched item is one tap for the user to fix, a confidently wrong one is a
silent error in their diary.`;

export function createGeminiReranker(): Reranker | undefined {
  const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
  if (!apiKey) return undefined;

  const ai = new GoogleGenAI({ apiKey });

  return {
    id: 'gemini-rerank',

    async choose({ phrase, context, candidates }) {
      if (candidates.length === 0) return { foodId: null, confidence: 0 };

      const list = candidates.map((c, i) => `${i}. ${c.name}`).join('\n');
      const prompt =
        `Phrase: "${phrase}"\n` +
        (context && context !== phrase ? `Seen in: "${context}"\n` : '') +
        `\nCandidates:\n${list}\n\nWhich is the same food?`;

      try {
        const response = await withRetry(
          () => ai.models.generateContent({
            model: DEFAULT_MODEL,
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            config: {
              systemInstruction: SYSTEM,
              responseMimeType: 'application/json',
              responseJsonSchema: SCHEMA,
              temperature: 0,
            },
          }),
          {
            label: 'gemini.rerank',
            attempts: 2,
            // One short question about a five-item list. If it has not answered
            // in 10 s it is not going to, and the honest fallback — ask the user —
            // is already the failure path.
            timeoutMs: 10_000,
            // So a hang is not retried — which the line above argues for and the
            // default policy was quietly undoing, because `CallTimeout` carries
            // status 408 and the default reads 408 as transient. Items resolve
            // concurrently, so the slowest one *is* the meal's latency, and a
            // second attempt here buys another 10 s of spinner for the whole
            // plate in exchange for a better answer to a question whose fallback
            // — ask the user — is already a good outcome. It was costing real
            // time: one exhausted retry turned a photo of six foods into 25 s.
            isRetryable: retryableExceptHang,
          },
        );

        const text = response.text;
        if (!text) return { foodId: null, confidence: 0 };

        const parsed = Verdict.safeParse(JSON.parse(text));
        if (!parsed.success) {
          metrics.inc('reranker_invalid_total', { reranker: 'gemini-rerank' });
          return { foodId: null, confidence: 0 };
        }

        const { choice, confidence, because } = parsed.data;
        metrics.inc('reranker_verdict_total', { verdict: choice === -1 ? 'none' : 'match' });

        if (choice === -1 || choice >= candidates.length) {
          logger.debug({ phrase, because }, 'reranker rejected every candidate');
          return { foodId: null, confidence: 0 };
        }

        const picked = candidates[choice];
        if (!picked) return { foodId: null, confidence: 0 };

        logger.debug({ phrase, chose: picked.name, confidence, because }, 'reranker chose');
        return { foodId: picked.foodId, confidence };
      } catch (err) {
        // A verifier that cannot be reached must not become an approver. Failing
        // closed sends the item to the user instead of accepting a match nobody
        // checked.
        metrics.inc('reranker_error_total', { reranker: 'gemini-rerank' });
        logger.warn({ err: String(err).slice(0, 160), phrase }, 'reranker unavailable');
        return { foodId: null, confidence: 0 };
      }
    },
  };
}
