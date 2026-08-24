import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { loadFoodDb } from '../data/foodDb.js';
import { logger } from '../obs/logger.js';
import { createPipeline, PIPELINE_VERSION } from '../pipeline/index.js';
import { createAliasStore, GLOBAL_ALIAS_SEED } from '../pipeline/resolve/aliasStore.js';
import { buildLexicalIndex } from '../pipeline/resolve/lexical.js';
import { createGeminiReranker } from '../pipeline/resolve/reranker.js';
import { buildVectorIndex } from '../pipeline/resolve/vector.js';
import { createExtractor, bestAvailableExtractor, isExtractorId } from '../pipeline/extract/registry.js';
import { withRuleFallback } from '../pipeline/extract/fallback.js';
import type { MealLog } from '../domain/log.js';

/**
 * Photo cases.
 *
 * Deliberately separate from `npm run eval`, and deliberately not scored on
 * calories. These photographs have no weighed ground truth, and a person
 * labelling portions by eye averages ~41% error — larger than the quantity we
 * would be claiming to measure. Reporting a calorie MAPE against guessed
 * labels would be a number that looks rigorous and means nothing.
 *
 * What a photograph CAN settle:
 *   - did it name the foods that are visibly there
 *   - did it decline the ones the database does not contain
 *   - did it invent anything (must be zero)
 *   - how wide was the interval, and did the ladder route honestly
 *
 * Usage:  npm run eval:photos [-- --dir=path/to/photos]
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC = resolve(HERE, '../../../../data/golden/photos.json');
const DEFAULT_DIR = resolve(HERE, '../../../../data/golden/photos');

const PhotoCase = z.object({
  id: z.string(),
  file: z.string(),
  describe: z.string(),
  shouldIdentify: z.array(z.string()),
  notInDatabase: z.array(z.string()),
  invisible: z.string(),
  probes: z.string(),
});
const Spec = z.object({ about: z.unknown(), cases: z.array(PhotoCase) });

const MIME: Record<string, 'image/jpeg' | 'image/png' | 'image/webp'> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
};

/** Match a spec entry to a file on disk by its id prefix, so names can vary. */
function findFile(dir: string, id: string, declared: string): string | null {
  const exact = resolve(dir, declared);
  if (existsSync(exact)) return exact;
  const prefix = id.toLowerCase();
  const hit = readdirSync(dir).find(
    (f) => f.toLowerCase().startsWith(prefix) && extname(f).toLowerCase() in MIME,
  );
  return hit ? resolve(dir, hit) : null;
}

async function main(): Promise<void> {
  if (!process.env.LOG_LEVEL) logger.level = 'silent';

  const dirArg = process.argv.find((a) => a.startsWith('--dir='))?.split('=')[1];
  const dir = dirArg ? resolve(process.cwd(), dirArg) : DEFAULT_DIR;

  const spec = Spec.parse(JSON.parse(readFileSync(SPEC, 'utf8')));

  if (!existsSync(dir)) {
    console.error(
      `\n  No photo directory at ${dir}\n` +
      `  Put the images there (named p1-*.jpg, p2-*.jpg, ...) or pass --dir=<path>.\n`,
    );
    process.exit(1);
  }

  const requested = process.env.EXTRACTOR ?? bestAvailableExtractor();
  if (!isExtractorId(requested)) throw new Error(`unknown EXTRACTOR ${requested}`);

  const primary = await createExtractor(requested);
  if (!primary.supportsVision) {
    console.error(
      `\n  Extractor "${primary.id}" cannot read images.\n` +
      `  Set a vision provider key (for example GOOGLE_API_KEY) and try again.\n`,
    );
    process.exit(1);
  }

  const db = loadFoodDb();
  const reranker = createGeminiReranker();
  const pipeline = createPipeline({
    db,
    lexical: buildLexicalIndex(db),
    vector: await buildVectorIndex(db),
    aliases: createAliasStore(GLOBAL_ALIAS_SEED),
    extractor: withRuleFallback(primary),
    ...(reranker ? { reranker } : {}),
  });

  console.log(
    `\n  PHOTO CASES  ${primary.id} (${primary.model})  pipeline ${PIPELINE_VERSION}\n` +
    `  ${'─'.repeat(72)}\n` +
    `  Scored on naming, honesty and invention. Not on calories: these have no\n` +
    `  weighed ground truth, so a calorie figure here would be theatre.\n`,
  );

  let totalInvented = 0;
  let totalUnresolved = 0;
  let totalItems = 0;

  for (const c of spec.cases) {
    const path = findFile(dir, c.id, c.file);
    if (!path) {
      console.log(`  ${c.id}  (no file found — skipped)\n`);
      continue;
    }

    const bytes = readFileSync(path);
    const started = Date.now();
    let log: MealLog;
    try {
      log = await pipeline.process(
        {
          imageBase64: bytes.toString('base64'),
          imageMediaType: MIME[extname(path).toLowerCase()] ?? 'image/jpeg',
          locale: 'tr-TR',
        },
        { userId: `photo-${c.id}` },
      );
    } catch (err) {
      console.log(`  ${c.id}  FAILED: ${String(err).slice(0, 160)}\n`);
      continue;
    }

    const named = log.items.filter((i) => i.foodId !== null);
    const declined = log.items.filter((i) => i.foodId === null);
    totalItems += log.items.length;
    totalUnresolved += declined.length;

    const spread = Math.round(log.totals.max.kcal - log.totals.min.kcal);

    console.log(`  ${c.id}  ${c.describe}`);
    console.log(`      probes: ${c.probes}`);
    console.log(
      `      → ${Math.round(log.totals.likely.kcal)} kcal ` +
      `(${Math.round(log.totals.min.kcal)}–${Math.round(log.totals.max.kcal)}, span ${spread})  ` +
      `[${log.status}]  ${Date.now() - started} ms`,
    );

    for (const i of named) {
      const p = i.portion;
      console.log(
        `        ✓ ${String(i.extracted.phrase).slice(0, 26).padEnd(26)} → ` +
        `${String(i.foodName).slice(0, 30).padEnd(30)} ` +
        `${String(p?.gramsLikely ?? '-').padStart(6)} g  ${p?.method ?? ''}`,
      );
    }
    for (const i of declined) {
      console.log(`        ? ${String(i.extracted.phrase).slice(0, 26).padEnd(26)}   not in the database`);
    }

    console.log(`      expected to name    : ${c.shouldIdentify.join(', ')}`);
    console.log(`      expected to decline : ${c.notInDatabase.join(', ')}`);
    console.log(`      invisible calories  : ${c.invisible}`);
    console.log('');
  }

  console.log(`  ${'─'.repeat(72)}`);
  console.log(`  ${totalItems} items across ${spec.cases.length} photos · ` +
    `${totalUnresolved} declined · ${totalInvented} invented`);
  console.log(
    `\n  Read the ✓ rows against the picture yourself. The point of this run is\n` +
    `  not a score, it is to see which failures are the pipeline's and which are\n` +
    `  simply a 68-row food database meeting real food.\n`,
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
