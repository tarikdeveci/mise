import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';

/**
 * Builds the second-tier food corpus from USDA FoodData Central.
 *
 * The curated seed is 87 rows, every one of them checked by hand, with Turkish
 * aliases and household measures. It is deliberately small and it will always
 * be too small: real meals contain chimichurri and pita and edamame.
 *
 * This produces the fallback the resolver drops to when the curated set has
 * nothing — USDA's own reference rows, trimmed to the five macros and a couple
 * of portions each, so that "mise does not know that food" becomes a citable
 * answer instead.
 *
 * **FDC is not one database, and that is the point of the table below.** It
 * publishes several sets with different jobs, and wiring only one of them left
 * a hole shaped exactly like a real meal:
 *
 *   sr_legacy   Ingredients, analysed. "Avocados, raw". The 2018 release, and
 *               the only set this build used to carry.
 *   survey      FNDDS — what people actually report eating, which means
 *               *dishes*: guacamole, sushi, lasagna. SR Legacy has none of
 *               those, so a plate of real food kept falling through to a
 *               question. This is the set that closes that gap.
 *   foundation  Few rows, deeply analysed, newest data. Small enough to be
 *               free and good enough to be worth preferring where it overlaps.
 *
 * Branded Foods is deliberately NOT here: it is roughly two million packaged
 * products and multiple gigabytes, and the barcode rung already answers that
 * question exactly, from a label, without retrieval guessing at it.
 *
 * It is a *second* tier rather than a replacement, and that distinction is the
 * whole design. Matching loosely across thousands of loosely-worded rows is
 * actively dangerous: a substring matcher over this corpus answers "iced tea"
 * with beef sandwich steaks and "grapes" with grapeseed oil, both roughly 10x
 * the real energy. Rows from here are never accepted on a retrieval score
 * alone — see the corpus rung in `resolve/router.ts`.
 *
 * Usage:  npm run build:corpus
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../../../../data/foods/fdc-corpus.json');
const CACHE = resolve(HERE, '../../.cache');

/**
 * The FDC sets this corpus is built from.
 *
 * Ordered worst-to-best on data quality, because a later set overwrites an
 * earlier one on the rare id collision, and because the *first* description
 * wins when two sets describe the same food — see `main`.
 */
interface Dataset {
  key: string;
  /** What this set is for, in the build log. */
  label: string;
  url: string;
  /**
   * The `data_type` this set's own rows carry.
   *
   * Not decoration: Foundation's `food.csv` holds 74,178 rows, of which 411
   * are foundation foods and the rest are the market acquisitions and
   * sub-samples those analyses were built from. Taking the file at face value
   * imported laboratory sub-samples as if they were foods.
   */
  type: string;
}

const DATASETS: Dataset[] = [
  {
    key: 'sr_legacy',
    label: 'SR Legacy — analysed ingredients (2018)',
    url: 'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_csv_2018-04.zip',
    type: 'sr_legacy_food',
  },
  {
    key: 'survey',
    label: 'FNDDS Survey — dishes people report eating (2021-2023)',
    url: 'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_survey_food_csv_2024-10-31.zip',
    type: 'survey_fndds_food',
  },
  {
    key: 'foundation',
    label: 'Foundation — deeply analysed, newest (2025)',
    url: 'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_foundation_food_csv_2025-04-24.zip',
    type: 'foundation_food',
  },
];

const zipPath = (ds: Dataset): string => resolve(CACHE, `${ds.key}.zip`);

/**
 * The four macros, by the name FDC gives them rather than by id.
 *
 * Hardcoded ids used to be enough and are not any more. `food_nutrient.csv`
 * identifies a nutrient by `nutrient_id` in SR Legacy and Foundation, but
 * FNDDS puts the *legacy NDB number* in that same column — 208 for energy
 * where the others say 1008 — so an id table matched nothing at all and FNDDS
 * imported as zero rows. Both are columns of each zip's own `nutrient.csv`, so
 * the mapping is read from the data instead of remembered.
 */
const MACRO_NAMES: Record<string, 'proteinG' | 'carbG' | 'fatG' | 'fiberG'> = {
  'protein': 'proteinG',
  'carbohydrate, by difference': 'carbG',
  'total lipid (fat)': 'fatG',
  'fiber, total dietary': 'fiberG',
};

/**
 * Energy, best source first.
 *
 * Foundation records plain `Energy` for only 135 of its 411 foods and the
 * Atwater figures for most of the rest, so insisting on the first name would
 * have thrown away two thirds of the newest and best-analysed set. Specific
 * Atwater factors are food-specific and therefore preferred over the general
 * ones where a row carries both.
 */
const ENERGY_NAMES = [
  'energy',
  'energy (atwater specific factors)',
  'energy (atwater general factors)',
];

interface NutrientKeys {
  /** Every token that identifies one of the four macros, id and legacy number alike. */
  macro: Map<string, 'proteinG' | 'carbG' | 'fatG' | 'fiberG'>;
  /** Same, for energy — the value is the preference rank, lower being better. */
  energy: Map<string, number>;
}

/** Reads one zip's `nutrient.csv` into the lookup `food_nutrient.csv` needs. */
function nutrientKeys(csv: string): NutrientKeys {
  const c = columns(csv);
  const macro = new Map<string, 'proteinG' | 'carbG' | 'fatG' | 'fiberG'>();
  const energy = new Map<string, number>();

  for (const r of rows(csv)) {
    const name = (r[c['name'] ?? 1] ?? '').trim().toLowerCase();
    const unit = (r[c['unit_name'] ?? 2] ?? '').trim().toUpperCase();
    // Both spellings of the same nutrient. They cannot collide: FDC ids are
    // four digits and legacy numbers are three.
    const tokens = [r[c['id'] ?? 0], r[c['nutrient_nbr'] ?? 3]].filter(Boolean) as string[];

    const rank = ENERGY_NAMES.indexOf(name);
    if (rank !== -1 && unit === 'KCAL') {
      for (const t of tokens) energy.set(t, rank);
      continue;
    }
    const key = MACRO_NAMES[name];
    if (key && unit === 'G') for (const t of tokens) macro.set(t, key);
  }
  return { macro, energy };
}

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
  /** Which FDC set this came from. Carried into the citation the app shows. */
  d?: string;
}

async function download(ds: Dataset): Promise<void> {
  const zip = zipPath(ds);
  if (existsSync(zip)) {
    console.log(`    using cached ${zip}`);
    return;
  }
  mkdirSync(CACHE, { recursive: true });
  console.log(`    downloading ${ds.url}`);
  const res = await fetch(ds.url);
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} for ${ds.url}`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(zip));
}

/**
 * Lists the paths inside a zip.
 *
 * The member path used to be hardcoded from the dataset name, which held for
 * exactly as long as there was one dataset: FDC's newer releases are stamped
 * with a full date and do not all wrap their CSVs in a folder named after the
 * archive. Asking the archive is one extra call and cannot go stale.
 */
function zipEntries(zip: string): string[] {
  const args = process.platform === 'win32'
    ? ['-NoProfile', '-Command', `$ErrorActionPreference='Stop';` +
        `Add-Type -A System.IO.Compression.FileSystem;` +
        `[IO.Compression.ZipFile]::OpenRead('${zip}').Entries | ForEach-Object { $_.FullName }`]
    : ['-Z1', zip];
  const bin = process.platform === 'win32' ? 'powershell' : 'unzip';
  return execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Reads one CSV out of the zip, found by filename rather than by full path.
 *
 * Shelling out to the platform's unzip keeps a 36 MB member from being buffered
 * twice and avoids adding a dependency for a build-time script.
 */
function readMember(zip: string, entries: string[], name: string): string | null {
  const path = entries.find((e) => e === name || e.endsWith(`/${name}`));
  if (!path) return null;
  const args = process.platform === 'win32'
    ? ['-NoProfile', '-Command', `$ErrorActionPreference='Stop';` +
        `Add-Type -A System.IO.Compression.FileSystem;` +
        `$z=[IO.Compression.ZipFile]::OpenRead('${zip}');` +
        `$e=$z.GetEntry('${path}');` +
        `$r=New-Object IO.StreamReader($e.Open());` +
        `$r.ReadToEnd()`]
    : ['-p', zip, path];
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

/** Everything one FDC set contributes, before it is merged with the others. */
function ingest(ds: Dataset, corpus: Record<string, CorpusRow>, seen: Set<string>): void {
  const zip = zipPath(ds);
  const entries = zipEntries(zip);

  const nutrientCsv = readMember(zip, entries, 'nutrient.csv');
  if (!nutrientCsv) throw new Error(`${ds.key}: no nutrient.csv inside ${zip}`);
  const keys = nutrientKeys(nutrientCsv);

  const foodCsv = readMember(zip, entries, 'food.csv');
  if (!foodCsv) throw new Error(`${ds.key}: no food.csv inside ${zip}`);
  const fc = columns(foodCsv);
  const names = new Map<string, string>();
  for (const r of rows(foodCsv)) {
    if ((r[fc['data_type'] ?? 1] ?? '') !== ds.type) continue;
    const id = r[fc['fdc_id'] ?? 0];
    const desc = r[fc['description'] ?? 2];
    if (id && desc) names.set(id, desc);
  }

  const nutCsv = readMember(zip, entries, 'food_nutrient.csv');
  if (!nutCsv) throw new Error(`${ds.key}: no food_nutrient.csv inside ${zip}`);
  const nc = columns(nutCsv);
  const per = new Map<string, Partial<Record<string, number>>>();
  /** Best energy seen per food, with the rank that made it best. */
  const energy = new Map<string, { rank: number; kcal: number }>();
  for (const r of rows(nutCsv)) {
    const token = r[nc['nutrient_id'] ?? 2] ?? '';
    const id = r[nc['fdc_id'] ?? 1];
    const amount = Number(r[nc['amount'] ?? 3]);
    if (!id || !Number.isFinite(amount)) continue;

    const rank = keys.energy.get(token);
    if (rank !== undefined) {
      const best = energy.get(id);
      if (!best || rank < best.rank) energy.set(id, { rank, kcal: amount });
      continue;
    }
    const key = keys.macro.get(token);
    if (!key) continue;
    const row = per.get(id) ?? {};
    row[key] = amount;
    per.set(id, row);
  }

  // A set with no portion table is not an error — Foundation is a set of
  // analyses rather than of servings. The corpus loader already carries a
  // default for a row that arrives without any.
  const portCsv = readMember(zip, entries, 'food_portion.csv');
  const portions = new Map<string, number[]>();
  if (portCsv) {
    const pc = columns(portCsv);
    for (const r of rows(portCsv)) {
      const id = r[pc['fdc_id'] ?? 1];
      const grams = Number(r[pc['gram_weight'] ?? 7]);
      // A "portion" heavier than a kilo is a bulk-purchase entry, not a serving.
      if (!id || !Number.isFinite(grams) || grams <= 0 || grams > 1000) continue;
      const list = portions.get(id) ?? [];
      if (list.length < 3) list.push(Math.round(grams * 10) / 10);
      portions.set(id, list);
    }
  }

  let kept = 0;
  let noEnergy = 0;
  let duplicate = 0;
  for (const [id, name] of names) {
    const kcal = energy.get(id)?.kcal;
    // Same validation the barcode path applies: a row we cannot defend is worse
    // than no row, because this tier is reached exactly when we are unsure.
    if (kcal === undefined || kcal < 0 || kcal > MAX_PLAUSIBLE_KCAL_100G) { noEnergy++; continue; }

    // Two sets describing one food in exactly the same words are one row to
    // retrieve, not two. Near-duplicates worded differently are left alone:
    // choosing between those is the verifier's job, and collapsing them here
    // would throw away the wording that made one of them findable.
    const fingerprint = name.trim().toLowerCase();
    if (seen.has(fingerprint)) { duplicate++; continue; }
    seen.add(fingerprint);

    const n = per.get(id);
    const g = portions.get(id);
    corpus[id] = {
      n: name,
      k: Math.round(kcal * 10) / 10,
      p: Math.round((n?.['proteinG'] ?? 0) * 10) / 10,
      c: Math.round((n?.['carbG'] ?? 0) * 10) / 10,
      f: Math.round((n?.['fatG'] ?? 0) * 10) / 10,
      fi: Math.round((n?.['fiberG'] ?? 0) * 10) / 10,
      ...(g?.length ? { g: [...g].sort((a, b) => b - a) } : {}),
      d: ds.key,
    };
    kept++;
  }

  console.log(
    `    ${names.size} in this set - ${kept} kept - ${noEnergy} without usable energy` +
    ` - ${duplicate} already described`,
  );
}

async function main(): Promise<void> {
  console.log('\n  Building the second-tier food corpus from USDA FoodData Central.\n');

  const corpus: Record<string, CorpusRow> = {};
  const seen = new Set<string>();
  for (const ds of DATASETS) {
    console.log(`  ${ds.label}`);
    await download(ds);
    ingest(ds, corpus, seen);
  }
  console.log('');

  const json = JSON.stringify(corpus);
  writeFileSync(OUT, json, 'utf8');
  const bySet = new Map<string, number>();
  for (const row of Object.values(corpus)) {
    bySet.set(row.d ?? '?', (bySet.get(row.d ?? '?') ?? 0) + 1);
  }
  console.log(
    `  wrote ${OUT}\n` +
    `  ${Object.keys(corpus).length} rows ` +
    `(${[...bySet].map(([k, v]) => `${k} ${v}`).join(', ')}), ` +
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
