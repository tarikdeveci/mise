import type { FoodDb } from '../../data/foodDb.js';
import type { FoodCandidate, Resolution } from '../../domain/log.js';
import { metrics } from '../../obs/metrics.js';
import { foodPhraseOnly, normalizeText } from '../normalize.js';
import type { AliasStore } from './aliasStore.js';
import { MIN_RESOLVABLE_SCORE, type LexicalIndex } from './lexical.js';
import type { VectorIndex } from './vector.js';

/**
 * The resolution router.
 *
 * The central claim of this design: **most food phrases are easy, and paying a
 * model to confirm that is waste.** So resolution is a ladder of increasingly
 * expensive strategies, and we stop at the first rung that answers decisively:
 *
 *   1. user alias      ~0 ms   this person already corrected this exact phrase
 *   2. global alias    ~0 ms   a curated default for a known-ambiguous term
 *   3. lexical         ~1 ms   decisive string match
 *   4. lexical+vector  ~15 ms  decisive after multilingual retrieval
 *   5. LLM rerank      ~800 ms genuinely ambiguous — a model earns its cost
 *   6. unresolved      —       ask the user one targeted question
 *
 * Two properties fall out of this that matter more than the latency:
 *
 *  - **Determinism.** Rungs 1-4 are pure functions. The same input gives the
 *    same output forever. Re-scanning the same meal cannot produce a different
 *    answer, which is a documented failure of shipped competitors.
 *  - **Bounded hallucination.** Rung 5 receives a CLOSED candidate list and can
 *    only return an id from it, or abstain. It cannot invent a food, and it
 *    never sees or authors a nutrition number.
 */

/** Above this margin between #1 and #2, the winner is not seriously contested. */
const DECISIVE_MARGIN = 0.18;

export interface Reranker {
  readonly id: string;
  /**
   * Choose among a closed candidate set, or abstain.
   * Implementations MUST NOT return an id outside `candidates`.
   */
  choose(args: {
    phrase: string;
    context: string;
    candidates: FoodCandidate[];
  }): Promise<{ foodId: string | null; confidence: number }>;
}

export interface ResolveDeps {
  db: FoodDb;
  lexical: LexicalIndex;
  vector: VectorIndex;
  aliases: AliasStore;
  reranker?: Reranker;
}

export interface ResolveOptions {
  userId: string;
  /** The full original input, given to the reranker as disambiguating context. */
  context?: string;
}

/** Fuse two independent retrievers. Agreement is evidence; it should not dilute. */
function fuse(lexical: FoodCandidate[], vector: FoodCandidate[]): FoodCandidate[] {
  const byId = new Map<string, { name: string; lex: number; vec: number }>();
  for (const c of lexical) {
    byId.set(c.foodId, { name: c.name, lex: c.score, vec: 0 });
  }
  for (const c of vector) {
    const prev = byId.get(c.foodId);
    if (prev) prev.vec = c.score;
    else byId.set(c.foodId, { name: c.name, lex: 0, vec: c.score });
  }

  return [...byId.entries()]
    .map(([foodId, { name, lex, vec }]) => ({
      foodId,
      name,
      // A strong signal from EITHER retriever stands on its own; agreement
      // between them adds a bounded bonus. Averaging would punish a food that
      // only one retriever can see — exactly the Turkish-term case that
      // motivated adding embeddings in the first place.
      score: Number(Math.min(1, Math.max(lex, vec) + 0.15 * Math.min(lex, vec)).toFixed(4)),
      via: (vec > lex ? 'vector' : 'lexical') as FoodCandidate['via'],
    }))
    .sort((a, b) => b.score - a.score);
}

const marginOf = (c: FoodCandidate[]): number =>
  Number(((c[0]?.score ?? 0) - (c[1]?.score ?? 0)).toFixed(4));

export async function resolvePhrase(
  deps: ResolveDeps,
  phrase: string,
  opts: ResolveOptions,
): Promise<Resolution> {
  const { db, lexical, vector, aliases, reranker } = deps;
  const clean = foodPhraseOnly(phrase);

  const done = (
    method: Resolution['method'],
    foodId: string | null,
    candidates: FoodCandidate[],
    margin: number,
  ): Resolution => {
    metrics.recordResolution(method);
    return { method, foodId, candidates, margin };
  };

  /* 1 — this user's own correction. Deterministic replay, no model. */
  const userHit = aliases.lookup(opts.userId, clean);
  if (userHit?.scope === 'user') {
    return done('user_alias', userHit.foodId, [
      { foodId: userHit.foodId, name: db.byId(userHit.foodId)?.name ?? userHit.foodId, score: 1, via: 'alias' },
    ], 1);
  }

  /* 2 — curated default for a known-ambiguous bare term. */
  if (userHit?.scope === 'global') {
    return done('global_alias', userHit.foodId, [
      { foodId: userHit.foodId, name: db.byId(userHit.foodId)?.name ?? userHit.foodId, score: 1, via: 'alias' },
    ], 1);
  }

  /* 3 — exact surface form in the food database. */
  const exact = db.byAlias(normalizeText(clean));
  if (exact) {
    return done('lexical', exact.id, [
      { foodId: exact.id, name: exact.name, score: 1, via: 'alias' },
    ], 1);
  }

  /* 4 — retrieval. Lexical always; vector only if it is actually loaded. */
  const lexCandidates = lexical.search(clean);
  const lexMargin = marginOf(lexCandidates);
  const lexTop = lexCandidates[0];

  if (lexTop && lexTop.score >= MIN_RESOLVABLE_SCORE && lexMargin >= DECISIVE_MARGIN) {
    return done('lexical', lexTop.foodId, lexCandidates, lexMargin);
  }

  const vecCandidates = vector.available ? await vector.search(clean) : [];
  const fused = fuse(lexCandidates, vecCandidates);
  const fusedMargin = marginOf(fused);
  const fusedTop = fused[0];

  if (fusedTop && fusedTop.score >= MIN_RESOLVABLE_SCORE && fusedMargin >= DECISIVE_MARGIN) {
    return done(fusedTop.via === 'vector' ? 'vector' : 'lexical', fusedTop.foodId, fused, fusedMargin);
  }

  /* 5 — genuinely contested. Now, and only now, a model is worth its cost. */
  const shortlist = fused.slice(0, 5);
  if (reranker && shortlist.length > 1) {
    const picked = await reranker.choose({
      phrase: clean,
      context: opts.context ?? phrase,
      candidates: shortlist,
    });

    // Trust boundary: a reranker that returns anything outside the closed
    // candidate set is buggy or compromised. We do not "fix up" the answer —
    // we drop it and fall through to asking the user.
    const legal = picked.foodId !== null && shortlist.some((c) => c.foodId === picked.foodId);
    if (legal) {
      return done('llm_rerank', picked.foodId, shortlist, fusedMargin);
    }
    if (picked.foodId !== null) {
      metrics.inc('reranker_illegal_choice_total', { reranker: reranker.id });
    }
  }

  /* 6 — abstain. An honest question beats a confident wrong answer. */
  return done('unresolved', null, fused.slice(0, 5), fusedMargin);
}
