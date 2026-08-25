import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createGapLedger } from './ledger.js';
import { renderGapReport, renderJsonl, summarise } from './report.js';
import { isGapKind, type GapKind } from './types.js';

/**
 * Gap CLI.
 *
 *   npm run gaps                          the report, as a person reads it
 *   npm run gaps -- --kind=unknown_food   one queue at a time
 *   npm run gaps -- --labelled            only records carrying a user's answer
 *   npm run gaps -- --jsonl train.jsonl   the export a fine-tune reads
 *   npm run gaps -- --limit=50
 *
 * It reads the same file the server writes, so it works against a running
 * server without talking to it. Nothing here mutates the ledger.
 */

const LABELLED: readonly GapKind[] = ['corrected_food', 'corrected_amount', 'split_compound'];

function main(argv: string[]): number {
  const get = (name: string): string | undefined =>
    argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  const has = (name: string): boolean => argv.includes(`--${name}`);

  const kind = get('kind');
  if (kind !== undefined && !isGapKind(kind)) {
    process.stderr.write(`Not a gap kind: ${kind}\n`);
    return 2;
  }

  // Forced on: `GAPS=off` stops the server collecting, but reading what was
  // already collected is a different act and should not need the flag flipped.
  const ledger = createGapLedger({ enabled: true });
  const limit = Number(get('limit') ?? 0);

  let entries = ledger.entries({
    ...(kind !== undefined && isGapKind(kind) ? { kind } : {}),
    ...(limit > 0 ? { limit } : {}),
  });
  if (has('labelled')) entries = entries.filter((e) => LABELLED.includes(e.kind));

  const target = argv[argv.indexOf('--jsonl') + 1];
  if (has('jsonl')) {
    if (!target || target.startsWith('--')) {
      process.stderr.write('--jsonl needs a file path\n');
      return 2;
    }
    const path = resolve(process.cwd(), target);
    writeFileSync(path, entries.length ? `${renderJsonl(entries)}\n` : '', 'utf8');
    process.stdout.write(`${entries.length} records → ${path}\n`);
    return 0;
  }

  process.stdout.write(`${renderGapReport(summarise(entries, ledger.stats()), entries)}\n`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
