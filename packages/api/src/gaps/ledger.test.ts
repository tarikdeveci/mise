import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { loadFoodDb } from '../data/foodDb.js';
import type { MealInput } from '../domain/log.js';
import { createPipeline } from '../pipeline/index.js';
import type { Extractor } from '../pipeline/extract/types.js';
import { createAliasStore, GLOBAL_ALIAS_SEED } from '../pipeline/resolve/aliasStore.js';
import { buildLexicalIndex } from '../pipeline/resolve/lexical.js';
import { createGapLedger } from './ledger.js';
import { renderGapReport, renderJsonl, summarise } from './report.js';
import type { GapObservation } from './types.js';

const made: string[] = [];
const freshDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mise-gaps-'));
  made.push(dir);
  return dir;
};

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

let dir: string;
beforeEach(() => { dir = freshDir(); });

const unknown = (subject: string, userId = 'u1'): GapObservation => ({
  kind: 'unknown_food', subject, sample: subject, userId,
});

describe('the ledger', () => {
  it('collapses repeats of one gap into a line with a count', () => {
    const ledger = createGapLedger({ dir, enabled: true });
    ledger.record(unknown('kinoa'));
    ledger.record(unknown('kinoa'));
    ledger.record(unknown('2 kase kinoa'));

    const [entry] = ledger.entries();
    expect(ledger.entries()).toHaveLength(1);
    expect(entry?.hits).toBe(3);
    // Quantities are stripped for the key, so one row is one thing to fix.
    expect(entry?.subject).toBe('kinoa');
  });

  it('counts distinct people, because one habit is not a trend', () => {
    const ledger = createGapLedger({ dir, enabled: true });
    ledger.record(unknown('kinoa', 'a'));
    ledger.record(unknown('kinoa', 'a'));
    ledger.record(unknown('kinoa', 'b'));

    expect(ledger.entries()[0]?.users).toBe(2);
  });

  it('never writes a user id, only a salted hash of one', () => {
    const ledger = createGapLedger({ dir, enabled: true });
    ledger.record(unknown('kinoa', 'device-12345'));
    ledger.flush();

    const written = readFileSync(resolve(dir, 'gaps.jsonl'), 'utf8');
    expect(written).toContain('kinoa');
    expect(written).not.toContain('device-12345');
  });

  it('keeps the hash out of the export as well', () => {
    const ledger = createGapLedger({ dir, enabled: true });
    ledger.record(unknown('kinoa', 'device-12345'));

    const exported = renderJsonl(ledger.entries());
    expect(exported).not.toContain('seenBy');
    expect(JSON.parse(exported).users).toBe(1);
  });

  it('survives a restart, hits and distinct users intact', () => {
    const first = createGapLedger({ dir, enabled: true });
    first.record(unknown('kinoa', 'a'));
    first.record(unknown('kinoa', 'b'));
    first.flush();

    const second = createGapLedger({ dir, enabled: true });
    const [entry] = second.entries();
    expect(entry?.hits).toBe(2);
    expect(entry?.users).toBe(2);

    // And the same person after a restart is still the same person.
    second.record(unknown('kinoa', 'a'));
    expect(second.entries()[0]?.users).toBe(2);
  });

  it('keeps one row per food id, not one row for all of them', () => {
    // The phrase cleaner strips numeric tokens, so keying identifiers through
    // it turned every `fdc:NNNNNN` into "fdc" and a single line claimed every
    // food's guessed portions. Identifiers are keyed literally.
    const ledger = createGapLedger({ dir, enabled: true });
    ledger.record({ kind: 'guessed_amount', subject: 'fdc:170392', userId: 'a' });
    ledger.record({ kind: 'guessed_amount', subject: 'fdc:174272', userId: 'a' });
    ledger.record({ kind: 'guessed_amount', subject: 'fdc:170392', userId: 'b' });

    const entries = ledger.entries();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.subject).sort()).toEqual(['fdc:170392', 'fdc:174272']);
    expect(entries.find((e) => e.subject === 'fdc:170392')?.hits).toBe(2);
  });

  it('keeps two corrections of one word apart when they disagree', () => {
    // Collapsing these would average away the only thing that made them
    // labels: what the person actually meant.
    const ledger = createGapLedger({ dir, enabled: true });
    ledger.record({ kind: 'corrected_food', subject: 'peynir', userId: 'a', expected: 'tr:kasar' });
    ledger.record({ kind: 'corrected_food', subject: 'peynir', userId: 'b', expected: 'fdc:173420' });

    expect(ledger.entries()).toHaveLength(2);
  });

  it('starts clean on a corrupt file rather than refusing to boot', () => {
    writeFileSync(resolve(dir, 'gaps.jsonl'), '{ not json at all\n', 'utf8');
    const ledger = createGapLedger({ dir, enabled: true });
    expect(ledger.enabled).toBe(true);
    expect(ledger.entries()).toEqual([]);
  });

  it('collects nothing when it is turned off', () => {
    const ledger = createGapLedger({ dir, enabled: false });
    ledger.record(unknown('kinoa'));
    expect(ledger.enabled).toBe(false);
    expect(ledger.entries()).toEqual([]);
  });

  it('ranks by distinct people first, then volume', () => {
    const ledger = createGapLedger({ dir, enabled: true });
    for (const u of ['a', 'b', 'c']) ledger.record(unknown('kimchi', u));
    for (let i = 0; i < 20; i++) ledger.record(unknown('tempeh', 'a'));

    expect(ledger.entries().map((e) => e.subject)).toEqual(['kimchi', 'tempeh']);
  });
});

/**
 * A measure word we cannot convert can only come from an extractor that read
 * one off real text — the rule tier emits a unit only when it already knows
 * how to convert it, so this kind is unreachable from the offline path. That
 * is exactly why it needs a test: otherwise the only way to find out whether
 * it works is to wait for a stranger to type "kepçe".
 */
describe('a unit we cannot convert', () => {
  const db = loadFoodDb();
  const vector = { available: false as const, search: async () => [] };

  const saying = (unit: string): Extractor => ({
    id: 'stub', model: 'test', supportsVision: false, promptVersion: 'test',
    extract: async (_input: MealInput) => ({
      items: [{ phrase: 'mercimek çorbası', quantity: 3, unit, preparation: 'unknown' as const, confidence: 0.9 }],
      notFood: false,
    }),
  });

  const run = async (unit: string) => {
    const gaps = createGapLedger({ dir, enabled: true });
    const pipeline = createPipeline({
      db, vector, gaps,
      lexical: buildLexicalIndex(db),
      aliases: createAliasStore(GLOBAL_ALIAS_SEED),
      extractor: saying(unit),
    });
    await pipeline.process({ text: `3 ${unit} mercimek çorbası`, locale: 'tr-TR' }, { userId: 'u-unit' });
    return gaps;
  };

  it('writes down the measure word, keyed literally so it can be looked up', async () => {
    const [entry] = (await run('kepçe')).entries({ kind: 'unknown_unit' });

    expect(entry?.subject).toBe('kepçe');
    // Keyed as the token, not as prose: the fix is a row in the unit table.
    expect(entry?.hits).toBe(1);
  });

  it('says nothing about a measure it can convert', async () => {
    expect((await run('kase')).entries({ kind: 'unknown_unit' })).toHaveLength(0);
  });
});

describe('erasure', () => {
  it('deletes a row only this person ever hit', () => {
    const ledger = createGapLedger({ dir, enabled: true });
    ledger.record(unknown('kinoa', 'device-1'));

    expect(ledger.forget('device-1')).toEqual({ deleted: 1, anonymised: 0 });
    expect(ledger.entries()).toHaveLength(0);
    expect(ledger.stats().observations).toBe(0);
  });

  it('keeps a row other people also hit, minus this person', () => {
    const ledger = createGapLedger({ dir, enabled: true });
    ledger.record(unknown('kinoa', 'device-1'));
    ledger.record(unknown('kinoa', 'device-2'));

    expect(ledger.forget('device-1')).toEqual({ deleted: 0, anonymised: 1 });
    // The word forty people typed is a fact about the vocabulary; the count of
    // people who typed it is what has to come down.
    expect(ledger.entries()[0]?.users).toBe(1);
  });

  it('leaves everybody else in place', () => {
    const ledger = createGapLedger({ dir, enabled: true });
    ledger.record(unknown('kinoa', 'device-1'));
    ledger.record(unknown('bulgur', 'device-2'));

    ledger.forget('device-1');
    expect(ledger.entries().map((e) => e.subject)).toEqual(['bulgur']);
  });

  it('reaches the file immediately, not after the debounce', () => {
    const ledger = createGapLedger({ dir, enabled: true });
    ledger.record(unknown('kinoa', 'device-1'));
    ledger.flush();
    expect(readFileSync(resolve(dir, 'gaps.jsonl'), 'utf8')).toContain('kinoa');

    // No flush() here on purpose: an erasure still sitting in a timer is not
    // an erasure, and the process may not survive the next two seconds.
    ledger.forget('device-1');
    expect(readFileSync(resolve(dir, 'gaps.jsonl'), 'utf8')).not.toContain('kinoa');
  });

  it('stays erased across a restart', () => {
    const first = createGapLedger({ dir, enabled: true });
    first.record(unknown('kinoa', 'device-1'));
    first.record(unknown('kinoa', 'device-2'));
    first.forget('device-1');

    const second = createGapLedger({ dir, enabled: true });
    expect(second.entries()[0]?.users).toBe(1);
    // Same salt, so the reloaded pseudonyms still resolve — erasing the second
    // person after a restart has to empty the row rather than miss it.
    expect(second.forget('device-2')).toEqual({ deleted: 1, anonymised: 0 });
    expect(second.entries()).toHaveLength(0);
  });

  it('reports nothing erased for someone who was never recorded', () => {
    const ledger = createGapLedger({ dir, enabled: true });
    ledger.record(unknown('kinoa', 'device-1'));

    expect(ledger.forget('device-nobody')).toEqual({ deleted: 0, anonymised: 0 });
    expect(ledger.entries()).toHaveLength(1);
  });
});

describe('the report', () => {
  it('separates what curation fixes from what a fine-tune could', () => {
    const ledger = createGapLedger({ dir, enabled: true });
    ledger.record(unknown('kinoa'));
    ledger.record(unknown('kimchi'));
    ledger.record({ kind: 'corrected_food', subject: 'peynir', userId: 'a', expected: 'tr:kasar' });

    const summary = summarise(ledger.entries(), ledger.stats());
    expect(summary.curate).toBe(2);
    expect(summary.train).toBe(1);
    expect(summary.labelled).toBe(1);

    const text = renderGapReport(summary, ledger.entries());
    expect(text).toContain('missing DATA, not a weak model');
    expect(text).toContain('kinoa');
  });

  it('marks a record as labelled only when the user supplied the answer', () => {
    const ledger = createGapLedger({ dir, enabled: true });
    ledger.record(unknown('kinoa'));
    ledger.record({
      kind: 'corrected_amount', subject: 'fdc:168878', userId: 'a',
      grams: { estimated: 158, corrected: 320 },
    });

    const lines = renderJsonl(ledger.entries()).split('\n').map((l) => JSON.parse(l));
    const guessed = lines.find((l) => l.kind === 'unknown_food');
    const corrected = lines.find((l) => l.kind === 'corrected_amount');

    expect(guessed).not.toHaveProperty('label');
    expect(corrected.grams).toEqual({ estimated: 158, corrected: 320 });
  });

  it('reports percentages over the rows it is actually showing', () => {
    // A single-kind view used to print that kind's list under the whole
    // ledger's percentages, which reads as a finding about the ledger.
    const ledger = createGapLedger({ dir, enabled: true });
    ledger.record(unknown('kinoa'));
    ledger.record(unknown('kimchi'));
    ledger.record({ kind: 'corrected_food', subject: 'peynir', userId: 'a', expected: 'tr:kasar' });

    const slice = ledger.entries({ kind: 'unknown_food' });
    const summary = summarise(slice, ledger.stats());

    expect(summary.observations).toBe(2);
    expect(summary.train).toBe(0);
    // And the "what does this mean" conclusion is withheld: on one kind the
    // split is the filter talking, not the data.
    expect(renderGapReport(summary, slice)).not.toContain('READING THIS');
  });

  it('says so when it has nothing, instead of rendering an empty table', () => {
    const ledger = createGapLedger({ dir, enabled: true });
    const text = renderGapReport(summarise([], ledger.stats()), []);
    expect(text).toContain('Nothing recorded yet');
  });
});
