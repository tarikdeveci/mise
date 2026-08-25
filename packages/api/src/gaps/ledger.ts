import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../obs/logger.js';
import { metrics } from '../obs/metrics.js';
import { foodPhraseOnly } from '../pipeline/normalize.js';
import { GAP_TAXONOMY, type GapEntry, type GapKind, type GapObservation } from './types.js';

/**
 * The ledger of what mise does not know.
 *
 * Metrics already count how often each rung fires. This is the other half:
 * **which words** defeated us, so the answer to "what should we build next" is
 * a list of rows to add rather than a percentage that moved.
 *
 * Three properties it has to have, and each one is a constraint rather than a
 * feature:
 *
 *  - **It aggregates.** One line per distinct gap, not per request. A thousand
 *    people typing "kinoa" is one row to write, and a log that made you count
 *    it yourself would not get read.
 *  - **It is bounded.** A capped table, evicting the least-seen, with the
 *    eviction count kept and reported. Silently dropping the tail would make
 *    the report read as complete when it is not.
 *  - **It is careful with people.** Meal text is health data, which is why the
 *    logger redacts it. This file deliberately does the opposite — the words
 *    ARE the deliverable — so it earns that by storing as little else as
 *    possible: user ids are salted hashes used only to count distinct people,
 *    the salt is generated per installation and never leaves the disk, and the
 *    export never emits the hashes. It writes outside the repository and the
 *    directory is git-ignored. Set `GAPS=off` and none of it is collected.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = resolve(HERE, '../../.gaps');

/** Distinct gaps held at once. Past this the least-seen are evicted. */
const MAX_ENTRIES = 5_000;
/** Verbatim spellings kept per gap. Enough to see the variants, not a corpus. */
const MAX_SAMPLES = 3;
/** Longest text kept, in characters. A meal description, not an essay. */
const MAX_TEXT = 200;
/** Quiet period before a changed ledger is written back. */
const FLUSH_DELAY_MS = 2_000;

export interface GapLedger {
  readonly enabled: boolean;
  readonly reason?: string;
  record(observation: GapObservation): void;
  entries(filter?: { kind?: GapKind; limit?: number }): GapEntry[];
  /** Distinct gaps held, and observations dropped to stay inside the cap. */
  stats(): { entries: number; observations: number; evicted: number };
  /**
   * Erases one person from the ledger, and persists immediately.
   *
   * A gap row is derived personal data — the phrase that defeated the resolver
   * is a sentence somebody typed — so erasure has to reach here. What it can
   * honestly promise depends on who else is in the row:
   *
   *   deleted     Only this person ever hit this gap. The row is theirs, so
   *               the row goes.
   *   anonymised  Other people hit it too. Their pseudonym is removed and the
   *               distinct-user count drops, but the row stays: a word forty
   *               people typed is a fact about the vocabulary, not about any
   *               one of them.
   *
   * Deleting the shared rows as well would be the stronger promise, and it is
   * the wrong one: the only way to know which of the kept samples was whose is
   * to store that mapping, which means retaining *more* personal data in order
   * to be able to erase it. The report is aggregate by construction, and this
   * keeps it that way.
   */
  forget(userId: string): { deleted: number; anonymised: number };
  /** Writes pending changes now. The CLI and the tests need this to be sync. */
  flush(): void;
}

const DISABLED: GapLedger = {
  enabled: false,
  reason: 'collection is off',
  record: () => {},
  entries: () => [],
  stats: () => ({ entries: 0, observations: 0, evicted: 0 }),
  forget: () => ({ deleted: 0, anonymised: 0 }),
  flush: () => {},
};

export interface GapLedgerOptions {
  dir?: string;
  /** Defaults to the `GAPS` environment variable; anything but "off" is on. */
  enabled?: boolean;
}

const clip = (text: string): string => text.trim().slice(0, MAX_TEXT);

/**
 * The aggregation key.
 *
 * `expected` is part of it so two users correcting the same word to two
 * different foods stay two rows. Collapsing them would average away the only
 * thing that made the record a label.
 *
 * Prose is keyed through the resolver's own cleaner, so "2 kase kinoa" and
 * "kinoa" are one row to write rather than two. Identifiers and unit tokens
 * are keyed literally, because that cleaner strips numeric tokens: every
 * `fdc:170392` collapsed to the key "fdc", and one line then claimed every
 * food's guessed portions as its own. See `GAP_TAXONOMY`.
 */
const keyOf = (o: Pick<GapObservation, 'kind' | 'subject' | 'expected'>): string => {
  const subject = GAP_TAXONOMY[o.kind].subject === 'phrase'
    ? foodPhraseOnly(o.subject)
    : o.subject.trim().toLowerCase();
  // A JSON array rather than a joined string: a subject containing the
  // separator would otherwise be able to collide with a different (subject,
  // expected) pair, and a key collision here silently merges two gaps.
  return JSON.stringify([o.kind, subject.slice(0, MAX_TEXT), o.expected ?? '']);
};

interface Row extends GapEntry {
  /** Salted hashes, for the distinct-user count. Never exported. */
  seenBy: Set<string>;
}

export function createGapLedger(opts: GapLedgerOptions = {}): GapLedger {
  const on = opts.enabled ?? process.env.GAPS !== 'off';
  if (!on) return DISABLED;

  const dir = opts.dir ?? process.env.GAPS_DIR ?? DEFAULT_DIR;
  let salt: string;
  try {
    mkdirSync(dir, { recursive: true });
    salt = loadSalt(dir);
  } catch (err) {
    // Degraded is better than dead: a food diary must not fail to log a meal
    // because a research file could not be opened.
    logger.warn({ err: String(err).slice(0, 200), dir }, 'gap ledger disabled: cannot write');
    return { ...DISABLED, reason: `cannot write to ${dir}` };
  }

  const path = resolve(dir, 'gaps.jsonl');
  const rows = new Map<string, Row>(load(path));
  let observations = [...rows.values()].reduce((sum, r) => sum + r.hits, 0);
  let evicted = 0;
  let pending: NodeJS.Timeout | undefined;

  const hash = (userId: string): string =>
    createHash('sha256').update(`${salt}:${userId}`).digest('hex').slice(0, 12);

  const write = (): void => {
    pending = undefined;
    try {
      // Write-then-rename: a process killed mid-write leaves the previous
      // ledger intact rather than a truncated one.
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, [...rows.values()].map(serialise).join('\n') + '\n', 'utf8');
      renameSync(tmp, path);
    } catch (err) {
      logger.warn({ err: String(err).slice(0, 200) }, 'could not persist gap ledger');
    }
  };

  const schedule = (): void => {
    if (pending) return;
    pending = setTimeout(write, FLUSH_DELAY_MS);
    // Never hold the process open for a research file.
    pending.unref?.();
  };

  const flushNow = (): void => {
    if (pending) clearTimeout(pending);
    write();
  };

  return {
    enabled: true,

    record(o) {
      const key = keyOf(o);
      const now = new Date().toISOString();
      const existing = rows.get(key);
      observations++;
      metrics.inc('gap_total', { kind: o.kind });

      if (existing) {
        existing.hits++;
        existing.lastSeen = now;
        existing.seenBy.add(hash(o.userId));
        existing.users = existing.seenBy.size;
        const sample = o.sample ? clip(o.sample) : undefined;
        if (sample && !existing.samples.includes(sample) && existing.samples.length < MAX_SAMPLES) {
          existing.samples.push(sample);
        }
        // Later evidence is better evidence: a fresher shortlist reflects the
        // database as it stands now, not as it stood the first time we failed.
        if (o.candidates) existing.candidates = o.candidates;
        if (o.grams) existing.grams = o.grams;
        schedule();
        return;
      }

      if (rows.size >= MAX_ENTRIES) evict(rows, () => { evicted++; });

      const seenBy = new Set([hash(o.userId)]);
      rows.set(key, {
        kind: o.kind,
        subject: clip(o.subject),
        hits: 1,
        users: 1,
        firstSeen: now,
        lastSeen: now,
        samples: o.sample ? [clip(o.sample)] : [],
        seenBy,
        ...(o.observed !== undefined ? { observed: o.observed } : {}),
        ...(o.expected !== undefined ? { expected: o.expected } : {}),
        ...(o.candidates ? { candidates: o.candidates.slice(0, 5) } : {}),
        ...(o.grams ? { grams: o.grams } : {}),
        ...(o.note !== undefined ? { note: clip(o.note) } : {}),
      });
      schedule();
    },

    entries(filter = {}) {
      const all = [...rows.values()]
        .filter((r) => !filter.kind || r.kind === filter.kind)
        // Distinct people first, then volume: forty users hitting one word is a
        // different signal from one user hitting it forty times.
        .sort((a, b) => b.users - a.users || b.hits - a.hits || a.subject.localeCompare(b.subject))
        .map(strip);
      return filter.limit ? all.slice(0, filter.limit) : all;
    },

    stats: () => ({ entries: rows.size, observations, evicted }),

    forget(userId) {
      const pseudonym = hash(userId);
      let deleted = 0;
      let anonymised = 0;

      for (const [key, row] of rows) {
        if (!row.seenBy.delete(pseudonym)) continue;
        if (row.seenBy.size === 0) {
          rows.delete(key);
          // The observation count follows the rows it counted, or the report
          // would keep claiming hits that no longer exist anywhere.
          observations -= row.hits;
          deleted++;
        } else {
          row.users = row.seenBy.size;
          anonymised++;
        }
      }

      // Straight to disk rather than through the debounce: an erasure that is
      // still sitting in a timer is not an erasure, and the process may not
      // survive the next two seconds.
      if (deleted || anonymised) flushNow();
      return { deleted, anonymised };
    },

    flush: flushNow,
  };
}

/** Drops the least-useful row: fewest distinct users, then fewest hits. */
function evict(rows: Map<string, Row>, onEvict: () => void): void {
  let worstKey: string | undefined;
  let worst: Row | undefined;
  for (const [key, row] of rows) {
    if (!worst || row.users < worst.users || (row.users === worst.users && row.hits < worst.hits)) {
      worst = row;
      worstKey = key;
    }
  }
  if (worstKey !== undefined) {
    rows.delete(worstKey);
    onEvict();
  }
}

/** The public shape: everything except who was involved. */
function strip(row: Row): GapEntry {
  const { seenBy: _seenBy, ...entry } = row;
  return entry;
}

function serialise(row: Row): string {
  return JSON.stringify({ ...strip(row), seenBy: [...row.seenBy] });
}

function load(path: string): Array<[string, Row]> {
  if (!existsSync(path)) return [];
  try {
    const out: Array<[string, Row]> = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line) as GapEntry & { seenBy?: string[] };
      const row: Row = { ...parsed, seenBy: new Set(parsed.seenBy ?? []) };
      row.users = row.seenBy.size || parsed.users;
      out.push([keyOf(row), row]);
    }
    return out;
  } catch (err) {
    // A corrupt research file is not worth refusing to boot over, and it is
    // not worth silently overwriting either — say so, then start clean.
    logger.warn({ err: String(err).slice(0, 200), path }, 'gap ledger unreadable; starting empty');
    return [];
  }
}

/**
 * A per-installation salt, generated once and kept beside the ledger.
 *
 * Without it the hashes would be a plain dictionary of user ids: anyone
 * holding the file could confirm whether a given device had logged a given
 * food. With it they are pseudonyms that only this installation can resolve,
 * which is what makes the distinct-user count safe to keep.
 */
function loadSalt(dir: string): string {
  const path = resolve(dir, 'salt');
  if (existsSync(path)) return readFileSync(path, 'utf8').trim();
  const salt = randomBytes(24).toString('hex');
  writeFileSync(path, salt, 'utf8');
  return salt;
}
