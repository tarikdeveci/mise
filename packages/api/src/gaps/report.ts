import { GAP_TAXONOMY, LABELLED_KINDS, type GapEntry, type GapKind } from './types.js';

/**
 * What the ledger says, in the two forms it is actually used in: a page a
 * person reads to decide what to build, and a JSONL file a training run reads.
 *
 * The report leads with the split between curation and training rather than
 * with a total, because the total is the least useful number here. A pile of
 * 400 gaps that is 90% missing database rows and a pile of 400 that is 90%
 * model misjudgements call for completely different weeks of work.
 */

export interface GapSummary {
  entries: number;
  observations: number;
  evicted: number;
  /** Observations whose fix is a row, an alias or a measure. */
  curate: number;
  /** Observations whose fix is a better model. */
  train: number;
  /** Of those, the ones carrying an answer the user supplied. */
  labelled: number;
  byKind: Array<{
    kind: GapKind;
    label: string;
    fix: string;
    owner: string;
    entries: number;
    hits: number;
    users: number;
  }>;
}

/**
 * Everything here is derived from the entries handed in, never from a global
 * count, so a filtered report is internally consistent: asking for one kind
 * used to print that kind's list under the whole ledger's percentages, which
 * read as "33% of your gaps are curation" when it meant "6 of 18 rows shown".
 * Only `evicted` comes from outside, because a dropped row is by definition
 * not in any list.
 */
export function summarise(
  entries: GapEntry[],
  stats: { evicted: number },
): GapSummary {
  const byKind = (Object.keys(GAP_TAXONOMY) as GapKind[])
    .map((kind) => {
      const mine = entries.filter((e) => e.kind === kind);
      return {
        kind,
        label: GAP_TAXONOMY[kind].label,
        fix: GAP_TAXONOMY[kind].fix,
        owner: GAP_TAXONOMY[kind].owner,
        entries: mine.length,
        hits: mine.reduce((sum, e) => sum + e.hits, 0),
        users: Math.max(0, ...mine.map((e) => e.users)),
      };
    })
    .filter((k) => k.entries > 0)
    .sort((a, b) => b.hits - a.hits);

  const hitsWhere = (test: (kind: GapKind) => boolean): number =>
    entries.filter((e) => test(e.kind)).reduce((sum, e) => sum + e.hits, 0);

  return {
    entries: entries.length,
    observations: entries.reduce((sum, e) => sum + e.hits, 0),
    evicted: stats.evicted,
    curate: hitsWhere((k) => GAP_TAXONOMY[k].fix === 'curate'),
    train: hitsWhere((k) => GAP_TAXONOMY[k].fix === 'train'),
    labelled: hitsWhere((k) => LABELLED_KINDS.includes(k)),
    byKind,
  };
}

/* ──────────────────────────── rendering ──────────────────────────── */

const bar = (label: string): string => `\n${label}\n${'─'.repeat(74)}`;
const row = (k: string, v: string | number, note = ''): string =>
  `  ${k.padEnd(26)} ${String(v).padStart(8)}  ${note}`;
const pct = (n: number, d: number): number => (d === 0 ? 0 : Math.round((100 * n) / d));

export function renderGapReport(
  summary: GapSummary,
  entries: GapEntry[],
  perKind = 8,
): string {
  const out: string[] = [];

  out.push(bar(`GAPS  ${summary.entries} distinct  ·  ${summary.observations} observations`));

  if (summary.entries === 0) {
    out.push('\n  Nothing recorded yet. Log some meals and come back — this file only');
    out.push('  fills up from real traffic, which is the point of it.');
    return out.join('\n');
  }

  out.push('\n  WHAT WOULD FIX THEM');
  out.push(row('curate', summary.curate, `${pct(summary.curate, summary.observations)}% — rows, aliases, measures`));
  out.push(row('train', summary.train, `${pct(summary.train, summary.observations)}% — model judgement`));
  out.push(row('of which labelled', summary.labelled, 'the user supplied the answer'));
  if (summary.evicted > 0) {
    out.push(row('evicted', summary.evicted, 'dropped at the cap — this report is not complete'));
  }

  out.push(bar('BY KIND  (what to fix, and where)'));
  for (const k of summary.byKind) {
    out.push(
      `  ${String(k.hits).padStart(5)}x  ${k.kind.padEnd(17)} ${k.fix.padEnd(7)} ${k.label}` +
      `\n         ${String(k.entries).padStart(4)} distinct  →  ${k.owner}/`,
    );
  }

  for (const k of summary.byKind) {
    const mine = entries.filter((e) => e.kind === k.kind).slice(0, perKind);
    if (mine.length === 0) continue;
    out.push(bar(`${k.kind.toUpperCase()}  ·  ${k.label}`));
    for (const e of mine) {
      out.push(`  ${String(e.hits).padStart(4)}x ${String(e.users).padStart(3)}u  ${e.subject}${detailOf(e)}`);
    }
    if (k.entries > mine.length) {
      out.push(`         … and ${k.entries - mine.length} more`);
    }
  }

  // The sentence this whole file exists to make possible, and the one it would
  // be easy to leave out because it is the less flattering half. Withheld on a
  // single-kind view, where the split is not a finding — it is the filter.
  if (summary.byKind.length < 2) return out.join('\n');

  out.push(bar('READING THIS'));
  if (summary.curate >= summary.train) {
    out.push(`  ${pct(summary.curate, summary.observations)}% of what mise did not know is missing DATA, not a weak model.`);
    out.push('  Fine-tuning cannot supply a calorie figure — that has to come from a row');
    out.push('  someone can cite, which is the architecture working as intended. Start');
    out.push('  with the unknown_food and uncurated_food lists above.');
  } else {
    out.push(`  Most of the pile is model judgement (${pct(summary.train, summary.observations)}%), which is the`);
    out.push('  half a fine-tune can move. Start with the labelled records.');
  }
  out.push('');
  out.push(`  ${summary.labelled} observations carry an answer the user gave, so they are usable`);
  out.push('  as training pairs directly. The rest are candidates: they record what was');
  out.push('  asked and what came out, and still need a human to say what should have.');

  return out.join('\n');
}

function detailOf(e: GapEntry): string {
  if (e.grams) return `   ${e.grams.estimated} g → ${e.grams.corrected} g`;
  if (e.expected) return `   ${e.observed ?? '(nothing)'} → ${e.expected}`;
  if (e.observed) return `   → ${e.observed}`;
  if (e.candidates?.length) {
    return `   best guess: ${e.candidates[0]!.name} (${e.candidates[0]!.score.toFixed(2)})`;
  }
  return '';
}

/**
 * One JSON object per line, for a training run to read.
 *
 * `label` is present only where the user actually supplied the answer, so a
 * pipeline consuming this can filter on it rather than having to know which
 * kinds happen to be trustworthy.
 */
export function renderJsonl(entries: GapEntry[]): string {
  return entries
    .map((e) => JSON.stringify({
      kind: e.kind,
      fix: GAP_TAXONOMY[e.kind].fix,
      subject: e.subject,
      hits: e.hits,
      users: e.users,
      firstSeen: e.firstSeen,
      lastSeen: e.lastSeen,
      samples: e.samples,
      ...(e.observed !== undefined ? { observed: e.observed } : {}),
      ...(e.candidates ? { candidates: e.candidates } : {}),
      ...(e.note !== undefined ? { note: e.note } : {}),
      ...(LABELLED_KINDS.includes(e.kind)
        ? { label: e.expected ?? e.note ?? null, grams: e.grams ?? null }
        : {}),
    }))
    .join('\n');
}
