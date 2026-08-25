import type { FoodCandidate } from '../../domain/log.js';
import { normalizeText, stemPhrase } from '../normalize.js';

/**
 * Deterministic lexical retrieval.
 *
 * Two complementary signals, because they fail differently:
 *   - IDF-weighted token overlap catches "grilled chicken breast" → the right
 *     row even though "chicken" alone is nearly uninformative.
 *   - Trigram Dice similarity catches typos and morphology ("ekmegi"/"ekmek")
 *     that token matching misses entirely.
 *
 * Neither costs a network call, so this runs on every request and only the
 * genuinely ambiguous remainder is escalated.
 */

/**
 * Below this absolute score a "match" is string noise, not a food.
 * ("laptop" is 0.11 similar to "latte" — real, and meaningless.)
 *
 * The retriever still RETURNS such candidates; ranking is its only job. It is
 * the router that refuses to resolve below this bar. Keeping the constant here
 * means the retriever's tests and the router's gate cannot drift apart.
 */
export const MIN_RESOLVABLE_SCORE = 0.35;

/** Candidates weaker than this are not worth showing a reranker at all. */
const CANDIDATE_FLOOR = 0.08;

function trigrams(text: string): Set<string> {
  const padded = `  ${text} `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
  return out;
}

function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const g of a) if (b.has(g)) shared++;
  return (2 * shared) / (a.size + b.size);
}

export interface LexicalIndex {
  search(phrase: string, limit?: number): FoodCandidate[];
}

/**
 * The minimum a collection must expose to be searchable.
 *
 * Structural rather than `FoodDb` so the same scorer can index the curated seed
 * and the 7,793-row USDA corpus. One retriever, two tiers — a second
 * implementation would be a second set of scoring bugs.
 */
export interface Indexable {
  surfaces: ReadonlyArray<{ foodId: string; text: string; tokens: string[] }>;
  byId(id: string): { name: string } | undefined;
}

export function buildLexicalIndex(db: Indexable): LexicalIndex {
  // IDF over surface forms: a token that appears in many food names carries
  // little discriminative power, so matching it should not look decisive.
  const docFreq = new Map<string, number>();
  for (const s of db.surfaces) {
    for (const tok of new Set(s.tokens)) {
      docFreq.set(tok, (docFreq.get(tok) ?? 0) + 1);
    }
  }
  const total = db.surfaces.length;
  const idf = (tok: string): number => Math.log(1 + total / (1 + (docFreq.get(tok) ?? 0)));

  // Each surface is indexed twice: verbatim, and stemmed. Turkish inflection
  // ("çayın" vs "çay") otherwise defeats both token and trigram matching.
  const indexed = db.surfaces.map((s) => {
    const stemmed = stemPhrase(s.text);
    return {
      foodId: s.foodId,
      text: s.text,
      tokens: new Set(s.tokens),
      grams: trigrams(s.text),
      // The surface's own IDF mass, for the precision term in `blend`.
      weight: [...new Set(s.tokens)].reduce((sum, t) => sum + idf(t), 0),
      stemText: stemmed,
      stemTokens: new Set(stemmed.split(' ')),
      stemGrams: trigrams(stemmed),
      stemWeight: [...new Set(stemmed.split(' ').filter(Boolean))]
        .reduce((sum, t) => sum + idf(t), 0),
    };
  });

  return {
    search(phrase: string, limit = 8): FoodCandidate[] {
      const q = normalizeText(phrase);
      if (!q) return [];
      const qTokens = q.split(' ').filter(Boolean);
      const qTrigrams = trigrams(q);
      const qWeight = qTokens.reduce((sum, t) => sum + idf(t), 0) || 1;

      const qStem = stemPhrase(q);
      const qStemTokens = qStem.split(' ').filter(Boolean);
      const qStemTrigrams = trigrams(qStem);
      const qStemWeight = qStemTokens.reduce((sum, t) => sum + idf(t), 0) || 1;

      /**
       * Recall alone is not enough, and a real failure showed why.
       *
       * Scoring only "how much of the query does this surface explain" gives a
       * surface full marks for containing every query token, no matter what
       * else it contains. So "patates kızartması" scored 0.943 against the
       * alias "tatlı patates kızartması" — a different food at half the energy
       * — because the one word that distinguishes them was simply absent from
       * the arithmetic. The two came within 0.05 of each other and the item
       * went unresolved.
       *
       * `precision` is the missing half: how much of the surface the query
       * actually accounts for, weighted by IDF, so an unmatched *rare* token
       * ("tatlı") costs far more than an unmatched common one ("cooked").
       * Recall still dominates, because a person types less than the canonical
       * name and should not be punished for it.
       */
      const blend = (
        tokens: string[], weight: number, tri: Set<string>,
        sTokens: Set<string>, sGrams: Set<string>, sWeight: number,
      ): number => {
        let overlap = 0;
        for (const t of tokens) if (sTokens.has(t)) overlap += idf(t);
        const recall = overlap / weight;
        const precision = sWeight > 0 ? overlap / sWeight : 0;
        return 0.5 * recall + 0.2 * precision + 0.3 * dice(tri, sGrams);
      };

      // Best score per food — a food with many aliases should not out-rank a
      // better match just by having more surfaces to match against.
      const best = new Map<string, number>();

      for (const s of indexed) {
        // Exact surface equality is the strongest signal available and should
        // dominate; otherwise take the better of the verbatim and stemmed
        // readings, slightly discounting the stemmed one so an exact
        // inflected match still beats a stem coincidence.
        const score =
          s.text === q
            ? 1
            : Math.max(
                blend(qTokens, qWeight, qTrigrams, s.tokens, s.grams, s.weight),
                0.95 * blend(qStemTokens, qStemWeight, qStemTrigrams,
                             s.stemTokens, s.stemGrams, s.stemWeight),
              );

        const prev = best.get(s.foodId) ?? 0;
        if (score > prev) best.set(s.foodId, score);
      }

      return [...best.entries()]
        .filter(([, score]) => score > CANDIDATE_FLOOR)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([foodId, score]) => ({
          foodId,
          name: db.byId(foodId)?.name ?? foodId,
          score: Number(score.toFixed(4)),
          via: 'lexical' as const,
        }));
    },
  };
}
