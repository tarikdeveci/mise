import type { FoodDb } from '../../data/foodDb.js';
import type { ExtractedItem, FoodCandidate, Resolution } from '../../domain/log.js';
import type { GapLedger } from '../../gaps/ledger.js';
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
 *   5. LLM verify      ~800 ms plausible but not self-evident — a model checks
 *   6. corpus          ~800 ms not curated at all: USDA's full reference set, verified
 *   7. corpus choices  ~1 ms   no verifier: show candidates, never auto-accept
 *   8. unresolved      —       ask the user one targeted question
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
export const DECISIVE_MARGIN = 0.18;

/**
 * Above this absolute score the winner is close enough to a literal match to
 * take on its own.
 *
 * Below it, a decisive margin proves only that the runner-up was worse — not
 * that the winner is right. Real meal photos made that concrete: "sesame seeds"
 * beat everything else to tahini (sesame paste) uncontested and became the only
 * item logged for a bowl of noodles, and "spinach and cheese filling" resolved
 * to börek, a pastry. Both had a clear margin over nothing in particular.
 *
 * So a merely-plausible winner is verified rather than accepted, which is what
 * the reranker rung was always for.
 */
export const SELF_EVIDENT_SCORE = 0.72;

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
  /**
   * Retrieval over the full USDA corpus, reached only when the curated tier
   * has nothing. Optional: without it the resolver simply says it does not know
   * the food, which is the behaviour this system had before.
   */
  corpus?: LexicalIndex;
  /**
   * Where the words that defeated us are written down. Optional so the eval
   * and the tests resolve against a clean ledger — a benchmark run is not
   * production traffic and must not look like it.
   */
  gaps?: GapLedger;
}

export interface ResolveOptions {
  userId: string;
  /** The full original input, given to the reranker as disambiguating context. */
  context?: string;
  /**
   * Preparation as reported by the extractor. Boiled and fried versions of one
   * food differ by up to 3x in energy, so this is not a nicety — dropping it is
   * one of the largest single-item errors the system can make.
   */
  preparation?: ExtractedItem['preparation'];
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

/**
 * Small, auditable bridge into the English-only USDA descriptions.
 *
 * These are spelling/name equivalents, not food judgements: they only change
 * what text retrieval searches, and the resulting row still needs a model or
 * human verifier. Keeping this list explicit is safer than asking a model to
 * translate every unknown phrase before search, and it covers the common
 * Turkish spellings that otherwise look like an empty database.
 */
const CORPUS_QUERY_ALIASES: Readonly<Record<string, string>> = {
  kinoa: 'quinoa',
  kuskus: 'couscous',
  susi: 'sushi',
  guakamole: 'guacamole',
  'pad tay': 'pad thai',
  lazanya: 'lasagna',
};

/**
 * How far a candidate moves up when its cooking state matches what was stated.
 *
 * Expressed as a fraction of the distance to 1 rather than a multiplier, so the
 * boost can never saturate and flatten the ranking it was meant to sharpen.
 */
const PREPARATION_BOOST = 0.4;

/** Specific states that a generic "cooked" is compatible with. */
const COOKED_STATES = new Set(['cooked', 'boiled', 'fried', 'grilled', 'baked']);

/**
 * Re-scores candidates using the preparation the extractor reported.
 *
 * This exists because of a bug the eval caught, and the bug is worth recording:
 * a good extractor *lifts* preparation out of the phrase into its own field,
 * leaving "yumurta" where the text said "haşlanmış yumurta". The router used to
 * receive only the phrase, so that signal was extracted and then thrown away —
 * and boiled egg resolved to raw egg, fried chicken to grilled breast, and raw
 * rice to cooked rice (365 vs 130 kcal/100g, a 64% error).
 *
 * The rule tier never showed it, because it leaves the preparation word in the
 * phrase for the lexical matcher to find. The failure only appeared when a
 * model did its job properly, which is exactly the class of bug that a
 * multi-extractor bake-off is for.
 */
/**
 * True when a food's cooking state is explicitly incompatible with the stated
 * preparation. Used to stop the alias fast-path short-circuiting an explicit
 * statement; `n/a` and generic "cooked" never conflict.
 */
function stateConflicts(
  db: FoodDb,
  foodId: string,
  preparation: ExtractedItem['preparation'] | undefined,
): boolean {
  if (!preparation || preparation === 'unknown') return false;
  const food = db.byId(foodId);
  if (!food || food.state === 'n/a' || food.state === preparation) return false;
  if (preparation === 'cooked' && COOKED_STATES.has(food.state)) return false;
  if (food.state === 'cooked' && COOKED_STATES.has(preparation)) return false;
  return true;
}

function applyPreparation(
  db: FoodDb,
  candidates: FoodCandidate[],
  preparation: ExtractedItem['preparation'],
): FoodCandidate[] {
  if (preparation === 'unknown' || candidates.length === 0) return candidates;

  return candidates
    .map((c) => {
      const food = db.byId(c.foodId);
      // `n/a` means the food has no meaningful cooking state (olive oil, tea).
      // Neither evidence for nor against — leave it alone.
      if (!food || food.state === 'n/a') return c;

      if (food.state === preparation) {
        // Boost into the headroom rather than multiplying and clamping.
        //
        // `min(1, score * 1.4)` looked equivalent and was not: it pinned every
        // candidate above ~0.72 to exactly 1.0, so two rows that agreed on
        // preparation arrived at the margin check indistinguishable. That is how
        // "patates kızartması büyük boy" ended up unresolved — french fries and
        // sweet potato fries are both `fried`, entered the boost at different
        // scores, and left it tied at 1.0 with a margin of zero.
        //
        // This form is strictly monotonic, so agreeing on preparation can move a
        // candidate up the list but can never erase the evidence that separated
        // it from the next one.
        return { ...c, score: Number((c.score + (1 - c.score) * PREPARATION_BOOST).toFixed(4)) };
      }
      // "cooked" is a generic: it should not push a row down just for being
      // more specific about *how* it was cooked.
      if (preparation === 'cooked' && COOKED_STATES.has(food.state)) return c;
      if (food.state === 'cooked' && COOKED_STATES.has(preparation)) return c;

      // A different, explicit state is genuine evidence against this row.
      return { ...c, score: Number((c.score * 0.5).toFixed(4)) };
    })
    .sort((a, b) => b.score - a.score);
}

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

  /* 2 — curated default for a known-ambiguous bare term.
     Skipped when the stated preparation contradicts it: the default for bare
     "yumurta" is the raw row, but "haşlanmış yumurta" is not that food, and an
     alias shortcut must not outrank an explicit statement by the user. */
  if (userHit?.scope === 'global' && !stateConflicts(db, userHit.foodId, opts.preparation)) {
    return done('global_alias', userHit.foodId, [
      { foodId: userHit.foodId, name: db.byId(userHit.foodId)?.name ?? userHit.foodId, score: 1, via: 'alias' },
    ], 1);
  }

  /* 3 — exact surface form in the food database, same caveat. */
  const exact = db.byAlias(normalizeText(clean));
  if (exact && !stateConflicts(db, exact.id, opts.preparation)) {
    return done('lexical', exact.id, [
      { foodId: exact.id, name: exact.name, score: 1, via: 'alias' },
    ], 1);
  }

  /* 4 — retrieval. Lexical always; vector only if it is actually loaded. */
  const lexCandidates = applyPreparation(db, lexical.search(clean), opts.preparation ?? 'unknown');
  const lexMargin = marginOf(lexCandidates);
  const lexTop = lexCandidates[0];

  if (lexTop && lexTop.score >= SELF_EVIDENT_SCORE && lexMargin >= DECISIVE_MARGIN) {
    return done('lexical', lexTop.foodId, lexCandidates, lexMargin);
  }

  const vecCandidates = vector.available ? await vector.search(clean) : [];
  const fused = applyPreparation(db, fuse(lexCandidates, vecCandidates), opts.preparation ?? 'unknown');
  const fusedMargin = marginOf(fused);
  const fusedTop = fused[0];

  if (fusedTop && fusedTop.score >= SELF_EVIDENT_SCORE && fusedMargin >= DECISIVE_MARGIN) {
    return done(fusedTop.via === 'vector' ? 'vector' : 'lexical', fusedTop.foodId, fused, fusedMargin);
  }

  /* 5 — plausible but not self-evident, or genuinely contested. Either way the
     retrieval score alone cannot settle it, so a model checks the shortlist. */
  const shortlist = fused.slice(0, 5);
  if (reranker && shortlist.length > 0) {
    // A verifier is an optional accuracy improvement, not a dependency. One
    // that throws — a network fault, a bad deployment, a third-party
    // implementation with a bug — must cost us this item's verification, not
    // the whole meal. The bundled Gemini verifier already fails closed
    // internally; this guard makes that a property of the rung rather than of
    // one implementation's good manners.
    let picked: { foodId: string | null } = { foodId: null };
    try {
      picked = await reranker.choose({
        phrase: clean,
        context: opts.context ?? phrase,
        candidates: shortlist,
      });
    } catch {
      metrics.inc('reranker_error_total', { reranker: reranker.id });
      picked = { foodId: null };
    }

    // Trust boundary: a reranker that returns anything outside the closed
    // candidate set is buggy or compromised. We do not "fix up" the answer —
    // we drop it and fall through to asking the user.
    const legal = picked.foodId !== null && shortlist.some((c) => c.foodId === picked.foodId);
    if (legal) {
      // Reaching a model to settle this is the cost; an alias would make the
      // same answer deterministic and free, so it is worth writing down which
      // words keep needing one.
      deps.gaps?.record({
        kind: 'contested_food',
        subject: clean,
        sample: phrase,
        userId: opts.userId,
        observed: picked.foodId ?? undefined,
        candidates: shortlist.map((c) => ({ foodId: c.foodId, name: c.name, score: c.score })),
      });
      return done('llm_rerank', picked.foodId, shortlist, fusedMargin);
    }
    if (picked.foodId !== null) {
      metrics.inc('reranker_illegal_choice_total', { reranker: reranker.id });
    }

    // The verifier ran and endorsed nothing from the curated tier. Fall through
    // to the corpus rung below rather than returning here: once a check exists,
    // its "no" has to mean no, and rung 6's own guard already excludes this
    // case, so there is nothing left between here and the tail.
  }

  /* 6 — no verifier configured. Fall back to the old behaviour rather than
     refusing everything: a plausible match the user can correct in one tap is
     more useful than a blank, and the confidence score already reflects that
     it was not self-evident. */
  if (!reranker && fusedTop && fusedTop.score >= MIN_RESOLVABLE_SCORE && fusedMargin >= DECISIVE_MARGIN) {
    return done(fusedTop.via === 'vector' ? 'vector' : 'lexical', fusedTop.foodId, fused, fusedMargin);
  }

  /* 7 — the curated set has nothing. Most "I don't know that food" answers are
     really "nobody curated that food yet", so try USDA's full reference set.

     Reached from both paths above, deliberately: the commonest shape of an
     unknown food is not a contested shortlist, it is an EMPTY one. Wiring this
     only into the contested branch meant "quinoa" — no curated candidates at
     all — never got here, which is exactly backwards. */
  const wider = await resolveFromCorpus(deps, clean, opts, done);
  if (wider) return wider;

  /* 8 — abstain. An honest question beats a confident wrong answer.

     This is also the most valuable line in the gap ledger: a word real traffic
     used that neither tier can name. No amount of model work fixes it — it is
     a row somebody has to write — so it is recorded with the shortlist that
     came closest, which is usually enough to see what the row should be. */
  deps.gaps?.record({
    kind: 'unknown_food',
    subject: clean,
    sample: phrase,
    userId: opts.userId,
    candidates: fused.slice(0, 3).map((c) => ({ foodId: c.foodId, name: c.name, score: c.score })),
  });
  return done('unresolved', null, fused.slice(0, 5), fusedMargin);
}

/**
 * The corpus rung: USDA's full reference set.
 *
 * Everything the curated tier gives up on lands here, and the coverage gain is
 * large — of the foods real meal photographs produced and the seed could not
 * name, roughly three quarters have a real row in this corpus.
 *
 * Automatic acceptance is gated on the verifier and that is not a formality. Retrieval over thousands of
 * loosely-worded descriptions produces confident nonsense: measured on this
 * corpus, a plain matcher answers "iced tea" with beef sandwich steaks and
 * "grapes" with grapeseed oil. The curated tier is protected from that by being
 * eighty-odd rows somebody read. This tier has no such protection, so a model
 * that can say "none of these" is the only thing standing between a wide
 * corpus and a wrong number.
 *
 * Consequently: **no verifier, no automatic corpus match.** The shortlist is
 * still useful when a person is the verifier: returning it as an unresolved
 * item's choices gives the user coverage without turning a retrieval score
 * into nutrition. This is the safe version of the common "AI fallback" flow:
 * the system can suggest; only a model verifier or the user can accept.
 */
async function resolveFromCorpus(
  deps: ResolveDeps,
  clean: string,
  opts: ResolveOptions,
  done: (m: Resolution['method'], id: string | null, c: FoodCandidate[], margin: number) => Resolution,
): Promise<Resolution | null> {
  const { corpus, reranker } = deps;
  if (!corpus) return null;

  const corpusQuery = CORPUS_QUERY_ALIASES[clean] ?? clean;
  const hits = corpus.search(corpusQuery).filter((c) => c.score >= MIN_RESOLVABLE_SCORE);
  if (hits.length === 0) return null;

  const shortlist = hits.slice(0, 5);

  const waitForUser = (reason: string): Resolution => {
    metrics.inc('corpus_candidates_total', { reason });
    deps.gaps?.record({
      kind: 'unknown_food',
      subject: clean,
      sample: opts.context ?? clean,
      userId: opts.userId,
      note: `USDA candidates found; waiting for user confirmation (${reason})`,
      candidates: shortlist.map((c) => ({ foodId: c.foodId, name: c.name, score: c.score })),
    });
    return done('unresolved', null, shortlist, marginOf(shortlist));
  };

  // Retrieval alone is not evidence enough to display calories, but it is
  // enough to offer a closed list to the person who ate the meal. A correction
  // pointing at one of these rows is materialised by `corpusFood` and becomes
  // a deterministic user alias, so the same phrase is instant next time.
  if (!reranker) {
    return waitForUser('verifier unavailable');
  }

  let picked: { foodId: string | null } = { foodId: null };
  try {
    picked = await reranker.choose({
      phrase: clean,
      context: opts.context ?? clean,
      candidates: shortlist,
    });
  } catch {
    metrics.inc('reranker_error_total', { reranker: reranker.id });
    return waitForUser('verifier error');
  }

  const legal = picked.foodId !== null && shortlist.some((c) => c.foodId === picked.foodId);
  if (!legal) {
    if (picked.foodId !== null) {
      metrics.inc('reranker_illegal_choice_total', { reranker: reranker.id });
    }
    return waitForUser(picked.foodId === null ? 'verifier abstained' : 'verifier returned an invalid choice');
  }

  metrics.inc('corpus_resolution_total');
  // A real USDA citation, but nobody curated it: no Turkish name, no aliases,
  // no household measures, and a confidence ceiling that keeps it out of the
  // auto-logged set. Promoting these into the seed is the single highest-value
  // curation queue this system has.
  deps.gaps?.record({
    kind: 'uncurated_food',
    subject: clean,
    userId: opts.userId,
    observed: picked.foodId ?? undefined,
    note: shortlist.find((c) => c.foodId === picked.foodId)?.name,
  });
  return done('corpus', picked.foodId, shortlist, marginOf(shortlist));
}
