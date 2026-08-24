import { describe, it, expect } from 'vitest';
import { loadFoodDb } from '../../data/foodDb.js';
import type { ExtractedItem } from '../../domain/log.js';
import { createAliasStore, GLOBAL_ALIAS_SEED } from './aliasStore.js';
import { buildLexicalIndex } from './lexical.js';
import { resolvePhrase } from './router.js';

const db = loadFoodDb();
const deps = {
  db,
  lexical: buildLexicalIndex(db),
  vector: { available: false as const, reason: 'stubbed', search: async () => [] },
  aliases: createAliasStore(GLOBAL_ALIAS_SEED),
};

const resolve = (phrase: string, preparation: ExtractedItem['preparation'] = 'unknown') =>
  resolvePhrase(deps, phrase, { userId: 'test', preparation });

describe('preparation-aware resolution', () => {
  /**
   * Regression for a bug the model bake-off exposed.
   *
   * A well-behaved extractor lifts preparation out of the phrase into its own
   * field, so the router receives "yumurta" where the user wrote "haşlanmış
   * yumurta". Before this fix the router only saw the phrase, the alias
   * fast-path fired, and boiled egg resolved to raw egg. The rule tier hid the
   * bug entirely, because it leaves the preparation word in the phrase.
   */
  it('uses the extracted preparation when the phrase no longer carries it', async () => {
    expect((await resolve('yumurta', 'boiled')).foodId).toBe('fdc:173424');
    expect((await resolve('yumurta', 'fried')).foodId).toBe('fdc:172183');
    expect((await resolve('yumurta', 'raw')).foodId).toBe('fdc:171287');
  });

  it('separates raw from cooked rice, the largest state-driven error in the DB', async () => {
    // 365 vs 130 kcal/100g.
    expect((await resolve('pirinç', 'raw')).foodId).toBe('fdc:169708');
    expect((await resolve('pirinç', 'boiled')).foodId).toBe('fdc:169756');
  });

  it('separates fried from grilled chicken', async () => {
    expect((await resolve('chicken', 'fried')).foodId).toBe('fdc:171123');
    expect((await resolve('chicken', 'grilled')).foodId).toBe('fdc:171477');
  });

  it('keeps the curated default when no preparation is stated', async () => {
    expect((await resolve('yumurta')).foodId).toBe('fdc:171287');
    expect((await resolve('patates')).foodId).toBe('fdc:170026');
  });

  it('does not disturb foods that have no meaningful cooking state', async () => {
    // Olive oil and tea are `n/a`; a stated preparation is neither evidence
    // for nor against them, and must not push them down the list.
    expect((await resolve('zeytinyağı', 'fried')).foodId).toBe('fdc:171413');
    expect((await resolve('çay', 'boiled')).foodId).toBe('fdc:173175');
  });

  it('treats generic "cooked" as compatible with any specific method', async () => {
    const cooked = await resolve('pirinç', 'cooked');
    expect(cooked.foodId).toBe('fdc:169756');
    expect(cooked.foodId).not.toBe('fdc:169708');
  });

  it('still resolves deterministically — same input, same answer', async () => {
    const runs = await Promise.all([
      resolve('yumurta', 'boiled'),
      resolve('yumurta', 'boiled'),
      resolve('yumurta', 'boiled'),
    ]);
    expect(new Set(runs.map((r) => r.foodId)).size).toBe(1);
  });
});

/**
 * The verifier rung, and the trust boundary around it.
 *
 * Rung 5 is the only place in resolution where a model's answer is allowed to
 * pick the food, so it is the only place a model could introduce one. The
 * containment is a single condition in the router: an id outside the closed
 * candidate list is dropped rather than corrected. Everything the system claims
 * about not inventing foods reduces to that line, and until now nothing
 * exercised it.
 *
 * `sesame seeds` is the phrase used throughout because it is the real failure
 * that motivated the rung: it beat everything else to tahini uncontested, at a
 * score too low to be self-evident, and became the only item logged for a large
 * bowl of noodles.
 */
describe('the verifier rung', () => {
  const AMBIGUOUS = 'sesame seeds';

  /** A verifier that always names `foodId`, regardless of what it was shown. */
  const saying = (foodId: string | null) => ({
    id: 'fake',
    choose: async () => ({ foodId, confidence: 0.9 }),
  });

  const withVerifier = (reranker: { id: string; choose: () => Promise<{ foodId: string | null; confidence: number }> }) =>
    resolvePhrase({ ...deps, reranker }, AMBIGUOUS, { userId: 'test' });

  it('accepts a candidate the verifier picked from the list it was given', async () => {
    // Establish what the shortlist actually contains, then endorse its top row.
    const shortlist = (await resolve(AMBIGUOUS)).candidates;
    const top = shortlist[0];
    expect(top).toBeDefined();

    const result = await withVerifier(saying(top!.foodId));

    expect(result.foodId).toBe(top!.foodId);
    expect(result.method).toBe('llm_rerank');
  });

  it('drops an id that was never on the shortlist', async () => {
    // A real food, and a plausible one — but not among the candidates. This is
    // the shape a hallucinated or injected answer takes: syntactically perfect,
    // and outside the closed set.
    const smuggled = 'fdc:171413'; // olive oil, 884 kcal/100 g
    const shortlist = (await resolve(AMBIGUOUS)).candidates;
    expect(shortlist.some((c) => c.foodId === smuggled)).toBe(false);

    const result = await withVerifier(saying(smuggled));

    expect(result.foodId).toBeNull();
    expect(result.method).toBe('unresolved');
  });

  it('drops an id that is not a food at all', async () => {
    const result = await withVerifier(saying('../../etc/passwd'));
    expect(result.foodId).toBeNull();
  });

  it('leaves the item unresolved when the verifier rejects every candidate', async () => {
    const result = await withVerifier(saying(null));

    // Not "fall back to the best guess". The rung exists to be able to say no,
    // and a no that quietly becomes a yes is worse than never asking.
    expect(result.foodId).toBeNull();
    expect(result.method).toBe('unresolved');
  });

  it('survives a verifier that throws, and does not accept on the way out', async () => {
    const exploding = {
      id: 'fake',
      choose: async () => { throw new Error('upstream is down'); },
    };

    const result = await resolvePhrase({ ...deps, reranker: exploding }, AMBIGUOUS, { userId: 'test' });

    // A verifier that cannot be reached must not become an approver, and must
    // not take the meal down with it.
    expect(result.foodId).toBeNull();
    expect(result.method).toBe('unresolved');
  });

  it('never reaches the verifier for a phrase the cheap rungs settle', async () => {
    let asked = 0;
    const counting = {
      id: 'fake',
      choose: async () => { asked++; return { foodId: null, confidence: 0 }; },
    };

    await resolvePhrase({ ...deps, reranker: counting }, 'yumurta', { userId: 'test' });
    await resolvePhrase({ ...deps, reranker: counting }, 'zeytinyağı', { userId: 'test' });

    // The economic claim of the whole ladder: most phrases are easy, and paying
    // a model to confirm that is waste.
    expect(asked).toBe(0);
  });
});

describe('phrase cleaning must not change which food is meant', () => {
  /**
   * Regression for the worst defect found in this codebase.
   *
   * "tatlı" was listed as a unit — shorthand for "tatlı kaşığı", the dessert
   * spoon. So the phrase cleaner stripped it as a measure word, and "tatlı
   * patates" (sweet potato) arrived at the router as "patates". That exact-
   * matched the potato row at score 1.0 on rung 3, which meant: a confident,
   * deterministic, reproducible wrong food at roughly double the true energy
   * density, on a common Turkish ingredient — and it never reached the verifier
   * that exists to catch exactly this, because the deterministic rung answered
   * first.
   *
   * Every defence in this system was in place and none of them fired, because
   * the error happened before any of them ran.
   */
  it('does not strip "tatlı" out of "tatlı patates"', async () => {
    const r = await resolve('tatlı patates');
    expect(r.foodId).not.toBe('fdc:170026'); // Potato, raw
    expect(r.foodId).not.toBe('fdc:170032'); // Potato, french fried
  });

  /**
   * The full phrase behaves differently to the bare one, and the difference is
   * worth pinning rather than smoothing over.
   *
   * "tatlı patates kızartması" scores 0.694 against french fries: two of its
   * three words are that row's alias. That is below `SELF_EVIDENT_SCORE`, so it
   * correctly does NOT take the deterministic fast path — it reaches the
   * verifier, which is exactly where a judgement call belongs.
   *
   * These two tests therefore assert the routing, not the answer. Whether the
   * verifier then rules correctly on this pair is a model-quality question, and
   * on real photographs it has gone both ways; that is recorded in the README
   * rather than papered over with a threshold tuned until this one case passes.
   */
  it('sends sweet potato fries to the verifier instead of matching outright', async () => {
    const r = await resolve('tatlı patates kızartması');
    const top = r.candidates[0];

    expect(top?.foodId).toBe('fdc:170032');
    // The guard that keeps this out of the deterministic tier. If a database
    // edit ever pushes this above 0.72 it becomes a silent wrong answer again,
    // and this assertion is what fails first.
    expect(top!.score).toBeLessThan(0.72);
  });

  it('leaves sweet potato fries unresolved when a verifier rejects the match', async () => {
    const refusing = { id: 'fake', choose: async () => ({ foodId: null, confidence: 0 }) };
    const r = await resolvePhrase(
      { ...deps, reranker: refusing },
      'tatlı patates kızartması',
      { userId: 'test' },
    );

    expect(r.foodId).toBeNull();
  });

  it('falls back to the plausible match when no verifier is configured', async () => {
    // Deliberate, and stated in the router: without a checker, a match the user
    // can correct in one tap beats a blank. This test exists so the trade-off
    // is visible rather than discovered.
    expect((await resolve('tatlı patates kızartması')).foodId).toBe('fdc:170032');
  });

  it('admits it does not know sweet potato rather than substituting potato', async () => {
    // There is no sweet potato row in a 68-food database. Unresolved is the
    // correct answer, and the one the user can fix in a single tap.
    expect((await resolve('tatlı patates')).method).toBe('unresolved');
  });
});
