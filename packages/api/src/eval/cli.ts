import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadFoodDb } from '../data/foodDb.js';
import { logger } from '../obs/logger.js';
import { createPipeline, PIPELINE_VERSION } from '../pipeline/index.js';
import { createAliasStore, GLOBAL_ALIAS_SEED } from '../pipeline/resolve/aliasStore.js';
import { buildLexicalIndex } from '../pipeline/resolve/lexical.js';
import { buildVectorIndex } from '../pipeline/resolve/vector.js';
import { createExtractor, isExtractorId, availableExtractors, type ExtractorId } from '../pipeline/extract/registry.js';
import { loadGoldenSet, runCase, type CaseResult } from './harness.js';
import { renderFailures, renderSummary, summarise } from './report.js';

/**
 * Eval CLI.
 *
 *   npm run eval                        rule baseline, no network, no cost
 *   npm run eval -- --extractor=gemini  one provider
 *   npm run eval -- --compare           every provider with credentials
 *   npm run eval -- --stratum=adversarial
 *   npm run eval -- --no-vector         ablation: lexical retrieval only
 *   npm run eval -- --json out.json     machine-readable, for CI diffing
 *
 * Exit code is non-zero when a hallucination is detected, so CI fails on the
 * one error class we claim is structurally impossible.
 */

interface Args {
  extractors: ExtractorId[];
  stratum?: string;
  only?: string;
  useVector: boolean;
  json?: string;
  showFailures: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit?.split('=').slice(1).join('=');
  };
  const has = (name: string) => argv.includes(`--${name}`);

  let extractors: ExtractorId[] = ['rules'];
  if (has('compare')) {
    extractors = availableExtractors();
  } else {
    const requested = get('extractor');
    if (requested) {
      if (!isExtractorId(requested)) {
        throw new Error(`Unknown extractor "${requested}". Known: rules, gemini, openai, anthropic`);
      }
      extractors = [requested];
    }
  }

  return {
    extractors,
    stratum: get('stratum'),
    only: get('case'),
    useVector: !has('no-vector'),
    json: get('json'),
    showFailures: !has('quiet'),
  };
}

async function main(): Promise<void> {
  // The eval's output IS the report; per-request logs would bury it. Set at
  // runtime rather than via env, because ESM hoists imports above any
  // assignment here and the logger would already have read its level.
  if (!process.env.LOG_LEVEL) logger.level = 'silent';

  const args = parseArgs(process.argv.slice(2));

  const db = loadFoodDb();
  const lexical = buildLexicalIndex(db);
  const vector = args.useVector
    ? await buildVectorIndex(db)
    : { available: false as const, reason: 'disabled by --no-vector', search: async () => [] };

  if (!vector.available) {
    console.log(`\n  ⚠  vector retrieval OFF (${vector.reason}) — lexical only\n`);
  }

  let cases = loadGoldenSet();
  if (args.stratum) cases = cases.filter((c) => c.stratum === args.stratum);
  if (args.only) cases = cases.filter((c) => c.id === args.only);
  if (cases.length === 0) throw new Error('No cases matched the given filters.');

  const reports: Array<{ summary: ReturnType<typeof summarise>; results: CaseResult[] }> = [];

  for (const id of args.extractors) {
    const extractor = await createExtractor(id);
    // A fresh alias store per extractor: correction memory must not leak
    // between runs, or the second provider inherits the first one's answers
    // and the comparison is worthless.
    const aliases = createAliasStore(GLOBAL_ALIAS_SEED);
    const pipeline = createPipeline({ db, lexical, vector, aliases, extractor });

    const results: CaseResult[] = [];
    for (const testCase of cases) {
      results.push(await runCase(db, pipeline, testCase));
    }

    const summary = summarise(results, {
      extractor: extractor.id,
      model: extractor.model,
      pipelineVersion: PIPELINE_VERSION,
    });

    console.log(renderSummary(summary));
    if (args.showFailures) console.log(renderFailures(results));

    reports.push({ summary, results });
  }

  if (reports.length > 1) {
    console.log(`\n${'═'.repeat(74)}\n  MODEL BAKE-OFF\n${'═'.repeat(74)}`);
    console.log(
      `  ${'extractor'.padEnd(14)}${'pass'.padStart(8)}${'food'.padStart(8)}` +
      `${'kcalAPE'.padStart(9)}${'auto'.padStart(8)}${'ECE'.padStart(8)}${'p95ms'.padStart(9)}`,
    );
    for (const { summary: s } of reports) {
      console.log(
        `  ${s.extractor.padEnd(14)}${`${s.exactPassRate}%`.padStart(8)}${`${s.foodMatchAccuracy}%`.padStart(8)}` +
        `${`${s.kcalMedianApe}%`.padStart(9)}${`${s.autoLogRate}%`.padStart(8)}` +
        `${s.ece.toFixed(3).padStart(8)}${String(s.latencyP95).padStart(9)}`,
      );
    }
    console.log();
  }

  if (args.json) {
    const path = resolve(process.cwd(), args.json);
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(reports.map((r) => r.summary), null, 2));
    console.log(`\n  wrote ${path}\n`);
  }

  // The one hard gate: nutrition that cannot be traced to a database row.
  const hallucinated = reports.some((r) => r.summary.hallucinationRate > 0);
  if (hallucinated) {
    console.error('\n  ✗ FAIL: hallucinated nutrition detected — a pipeline boundary leaked.\n');
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
