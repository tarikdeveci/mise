import { describe, it, expect } from 'vitest';
import { loadFoodDb } from '../../data/foodDb.js';
import type { ExtractedItem } from '../../domain/log.js';
import type { GapLedger } from '../../gaps/ledger.js';
import type { GapObservation } from '../../gaps/types.js';
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
    expect((await resolve('yumurta', 'fried')).foodId).toBe('fdc:173423');
    expect((await resolve('yumurta', 'raw')).foodId).toBe('fdc:171287');
  });

  it('separates raw from cooked rice, the largest state-driven error in the DB', async () => {
    // 365 vs 130 kcal/100g.
    expect((await resolve('pirinç', 'raw')).foodId).toBe('fdc:168877');
    expect((await resolve('pirinç', 'boiled')).foodId).toBe('fdc:168878');
  });

  it('separates fried from grilled chicken', async () => {
    expect((await resolve('chicken', 'fried')).foodId).toBe('fdc:173346');
    expect((await resolve('chicken', 'grilled')).foodId).toBe('fdc:171477');
  });

  it('keeps the curated default when no preparation is stated', async () => {
    expect((await resolve('yumurta')).foodId).toBe('fdc:171287');
    expect((await resolve('patates')).foodId).toBe('fdc:170440');
  });

  it('does not disturb foods that have no meaningful cooking state', async () => {
    // Olive oil and tea are `n/a`; a stated preparation is neither evidence
    // for nor against them, and must not push them down the list.
    expect((await resolve('zeytinyağı', 'fried')).foodId).toBe('fdc:171413');
    expect((await resolve('çay', 'boiled')).foodId).toBe('fdc:173227');
  });

  it('treats generic "cooked" as compatible with any specific method', async () => {
    const cooked = await resolve('pirinç', 'cooked');
    expect(cooked.foodId).toBe('fdc:168878');
    expect(cooked.foodId).not.toBe('fdc:168877');
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
 * `spinach and cheese filling` is the phrase used throughout because it is a
 * real failure from a meal photograph: it resolved to börek, a pastry, on a
 * clear margin over nothing in particular.
 *
 * The rung's original motivating case — `sesame seeds` resolving to tahini and
 * becoming the only item logged for a bowl of noodles — is no longer usable
 * here, because the database now contains sesame seeds and the phrase resolves
 * on rung 3. That is the better fix: the cheapest way to stop a phrase reaching
 * a model is to give the database the food it was looking for.
 */
describe('the verifier rung', () => {
  const AMBIGUOUS = 'spinach and cheese filling';

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

/**
 * The ledger has an entry for a tie a model had to break, and until now
 * nothing proved the router ever writes one. It is the kind that decays
 * fastest — every one of these is an alias somebody could add to make the
 * same answer deterministic and free — so it is worth a test rather than a
 * hope that it fires in production.
 */
describe('what the verifier rung writes down', () => {
  const AMBIGUOUS = 'spinach and cheese filling';

  /** Collects observations in memory; the file format is the ledger's own test. */
  const recorder = () => {
    const seen: GapObservation[] = [];
    const ledger: GapLedger = {
      enabled: true,
      record: (o) => { seen.push(o); },
      entries: () => [],
      stats: () => ({ entries: seen.length, observations: seen.length, evicted: 0 }),
      forget: () => ({ deleted: 0, anonymised: 0 }),
      flush: () => {},
    };
    return { seen, ledger };
  };

  it('files a contested food when a model breaks the tie', async () => {
    const shortlist = (await resolve(AMBIGUOUS)).candidates;
    const top = shortlist[0];
    expect(top).toBeDefined();

    const { seen, ledger } = recorder();
    const result = await resolvePhrase(
      { ...deps, gaps: ledger, reranker: { id: 'fake', choose: async () => ({ foodId: top!.foodId, confidence: 0.9 }) } },
      AMBIGUOUS,
      { userId: 'test' },
    );

    expect(result.method).toBe('llm_rerank');
    const gap = seen.find((o) => o.kind === 'contested_food');
    expect(gap?.observed).toBe(top!.foodId);
    // The shortlist rides along: the row is only worth acting on if you can
    // see what the model was choosing between.
    expect(gap?.candidates?.length).toBeGreaterThan(0);
  });

  it('files nothing when the verifier endorses nobody', async () => {
    const { seen, ledger } = recorder();
    const result = await resolvePhrase(
      { ...deps, gaps: ledger, reranker: { id: 'fake', choose: async () => ({ foodId: null, confidence: 0.9 }) } },
      AMBIGUOUS,
      { userId: 'test' },
    );

    // It is an unknown food, not a contested one — a different queue, and a
    // different fix. Filing both would double-count one failure.
    expect(result.foodId).toBeNull();
    expect(seen.map((o) => o.kind)).not.toContain('contested_food');
  });
});

describe('phrase cleaning must not change which food is meant', () => {
  /**
   * Regression for the worst defect found in this codebase.
   *
   * "tatlı" was listed as a unit — shorthand for "tatlı kaşığı", the dessert
   * spoon. So the phrase cleaner stripped it as a measure word, and "tatlı
   * patates" (sweet potato) arrived at the router as "patates". That exact-
   * matched the potato row at score 1.0 on rung 3, which meant a confident,
   * deterministic, reproducible wrong food at roughly double the true energy
   * density, on a common Turkish ingredient — and it never reached the verifier
   * that exists to catch this, because the deterministic rung answered first.
   *
   * Every defence in this system was in place and none of them fired, because
   * the error happened before any of them ran.
   */
  it('does not strip "tatlı" out of "tatlı patates"', async () => {
    const r = await resolve('tatlı patates');
    expect(r.foodId).toBe('fdc:168483');           // sweet potato, baked
    expect(r.foodId).not.toBe('fdc:170440');       // not plain potato
  });

  /**
   * The second half of the same story, and the more interesting one.
   *
   * For a long time this phrase resolved to french fries, and the defence was
   * routing: it scored below `SELF_EVIDENT_SCORE`, so it reached the verifier
   * and became a question rather than a silent wrong answer. That was correct
   * but unsatisfying — the system was working hard to be honest about a food it
   * simply did not have.
   *
   * The real fix was data. USDA FDC 167606 is sweet potato fries, 182 kcal/100 g
   * against 90 for the baked flesh and 312 for potato fries. With the row
   * present the phrase resolves exactly, deterministically, with no model call —
   * which is the argument this whole design rests on.
   */
  it('resolves sweet potato fries to sweet potato fries', async () => {
    expect((await resolve('tatlı patates kızartması')).foodId).toBe('fdc:167606');
    expect((await resolve('sweet potato fries')).foodId).toBe('fdc:167606');
  });

  it('still separates them from potato fries, which differ by 130 kcal/100 g', async () => {
    expect((await resolve('patates kızartması')).foodId).toBe('fdc:170698');
  });
});
