import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';

/**
 * Builds the second-tier food corpus from USDA SR Legacy.
 *
 * The curated seed is 87 rows, every one of them checked by hand, with Turkish
 * aliases and household measures. It is deliberately small and it will always
 * be too small: real meals contain chimichurri and pita and edamame.
 *
 * This produces the fallback the resolver drops to when the curated set has
 * nothing — the same 7,793 reference foods USDA publishes, trimmed to the five
 * macros and a couple of portions each. Roughly 1 MB, which is worth carrying
 * to turn "mise does not know that food" into a citable answer.
 *
 * It is a *second* tier rather than a replacement, and that distinction is the
 * whole design. Matching loosely across 7,793 rows is actively dangerous: a
 * substring matcher over this corpus answers "iced tea" with beef sandwich
 * steaks and "grapes" with grapeseed oil, both roughly 10x the real energy.
 * Rows from here are never accepted on a retrieval score alone — see the
 * corpus rung in `resolve/router.ts`.
 *
 * Usage:  npm run build:corpus
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../../../../data/foods/fdc-corpus.json');
const CACHE = resolve(HERE, '../../.cache');
const ZIP = resolve(CACHE, 'sr-legacy.zip');

const DATASET =
  'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_csv_2018-04.zip';
const INNER = 'FoodData_Central_sr_legacy_food_csv_2018-04';

/** USDA nutrient ids for the five figures this system displays. */
const NUTRIENTS: Record<string, 'kcal' | 'proteinG' | 'carbG' | 'fatG' | 'fiberG'> = {
  '1008': 'kcal', '1003': 'proteinG', '1005': 'carbG', '1004': 'fatG', '1079': 'fiberG',
};

/** Energy above this per 100 g is not a food; the row is bad data. */
const MAX_PLAUSIBLE_KCAL_100G = 950;

export interface CorpusRow {
  /** USDA description, verbatim. */
  n: string;
  k: number;
  p: number;
  c: number;
  f: number;
  fi: number;
  /** Gram weights of the household portions USDA records, largest first. */
  g?: number[];
}

async function download(): Promise<void> {
  if (existsSync(ZIP)) {
    console.log(`  using cached ${ZIP}`);
    return;
  }
  mkdirSync(CACHE, { recursive: true });
  console.log(`  downloading ${DATASET}`);
  const res = await fetch(DATASET);
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(ZIP));
}

/**
 * Reads one CSV out of the zip.
 *
 * Shelling out to the platform's unzip keeps a 36 MB member from being buffered
 * twice and avoids adding a dependency for a build-time script.
 */
function readMember(name: string): string {
  const args = process.platform === 'win32'
    ? ['-Command', `$ErrorActionPreference='Stop';` +
        `Add-Type -A System.IO.Compression.FileSystem;` +
        `$z=[IO.Compression.ZipFile]::OpenRead('${ZIP}');` +
        `$e=$z.GetEntry('${INNER}/${name}');` +
        `$r=New-Object IO.StreamReader($e.Open());` +
        `$r.ReadToEnd()`]
    : ['-p', ZIP, `${INNER}/${name}`];
  const bin = process.platform === 'win32' ? 'powershell' : 'unzip';
  return execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
}

/** Minimal RFC-4180 row splitter: USDA quotes descriptions containing commas. */
function splitRow(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function* rows(csv: string): Generator<string[]> {
  const lines = csv.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line) yield splitRow(line);
  }
}

function columns(csv: string): Record<string, number> {
  const header = splitRow(csv.split(/\r?\n/, 1)[0] ?? '');
  return Object.fromEntries(header.map((h, i) => [h.replace(/^"|"$/g, ''), i]));
}

async function main(): Promise<void> {
  console.log('\n  Building the second-tier food corpus from USDA SR Legacy.\n');
  await download();

  console.log('  reading food.csv');
  const foodCsv = readMember('food.csv');
  const fc = columns(foodCsv);
  const names = new Map<string, string>();
  for (const r of rows(foodCsv)) {
    const id = r[fc['fdc_id'] ?? 0];
    const desc = r[fc['description'] ?? 2];
    if (id && desc) names.set(id, desc);
  }
  console.log(`    ${names.size} foods`);

  console.log('  reading food_nutrient.csv (36 MB)');
  const nutCsv = readMember('food_nutrient.csv');
  const nc = columns(nutCsv);
  const per = new Map<string, Partial<Record<string, number>>>();
  for (const r of rows(nutCsv)) {
    const key = NUTRIENTS[r[nc['nutrient_id'] ?? 2] ?? ''];
    if (!key) continue;
    const id = r[nc['fdc_id'] ?? 1];
    const amount = Number(r[nc['amount'] ?? 3]);
    if (!id || !Number.isFinite(amount)) continue;
    const row = per.get(id) ?? {};
    row[key] = amount;
    per.set(id, row);
  }
  console.log(`    ${per.size} foods carry nutrients`);

  console.log('  reading food_portion.csv');
  const portCsv = readMember('food_portion.csv');
  const pc = columns(portCsv);
  const portions = new Map<string, number[]>();
  for (const r of rows(portCsv)) {
    const id = r[pc['fdc_id'] ?? 1];
    const grams = Number(r[pc['gram_weight'] ?? 7]);
    // A "portion" heavier than a kilo is a bulk-purchase entry, not a serving.
    if (!id || !Number.isFinite(grams) || grams <= 0 || grams > 1000) continue;
    const list = portions.get(id) ?? [];
    if (list.length < 3) list.push(Math.round(grams * 10) / 10);
    portions.set(id, list);
  }

  const corpus: Record<string, CorpusRow> = {};
  let skipped = 0;
  for (const [id, name] of names) {
    const n = per.get(id);
    const kcal = n?.['kcal'];
    // Same validation the barcode path applies: a row we cannot defend is worse
    // than no row, because this tier is reached exactly when we are unsure.
    if (kcal === undefined || kcal < 0 || kcal > MAX_PLAUSIBLE_KCAL_100G) { skipped++; continue; }
    const g = portions.get(id);
    corpus[id] = {
      n: name,
      k: Math.round(kcal * 10) / 10,
      p: Math.round((n?.['proteinG'] ?? 0) * 10) / 10,
      c: Math.round((n?.['carbG'] ?? 0) * 10) / 10,
      f: Math.round((n?.['fatG'] ?? 0) * 10) / 10,
      fi: Math.round((n?.['fiberG'] ?? 0) * 10) / 10,
      ...(g?.length ? { g: [...g].sort((a, b) => b - a) } : {}),
    };
  }

  const json = JSON.stringify(corpus);
  writeFileSync(OUT, json, 'utf8');
  console.log(
    `\n  wrote ${OUT}\n` +
    `  ${Object.keys(corpus).length} rows, ${skipped} skipped as implausible or energy-less, ` +
    `${(Buffer.byteLength(json) / 1024 / 1024).toFixed(2)} MB\n`,
  );

  // Sanity: the rows the curated seed cites must all be present and agree.
  const seed = JSON.parse(readFileSync(resolve(HERE, '../../../../data/foods/seed.json'), 'utf8')) as
    Array<{ id: string; name: string; per100g: { kcal: number } }>;
  const disagree = seed
    .filter((f) => f.id.startsWith('fdc:') && /^\d+$/.test(f.id.slice(4)))
    .map((f) => ({ f, row: corpus[f.id.slice(4)] }))
    .filter(({ f, row }) => !row || Math.abs(row.k - f.per100g.kcal) > 0.6);

  if (disagree.length > 0) {
    console.error('  CITATION MISMATCH — the seed disagrees with the corpus it cites:');
    for (const { f, row } of disagree) {
      console.error(`    ${f.id} "${f.name}" says ${f.per100g.kcal} kcal; corpus says ${row?.k ?? 'no such row'}`);
    }
    process.exit(1);
  }
  console.log('  every curated citation checks out against the corpus.\n');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
