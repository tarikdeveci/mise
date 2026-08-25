import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CanonicalFood, HouseholdMeasure } from '../domain/food.js';
import { logger } from '../obs/logger.js';
import { normalizeText } from '../pipeline/normalize.js';

/**
 * The second-tier food corpus: USDA SR Legacy + FNDDS + Foundation.
 *
 * The curated seed answers the meals this system was designed around, in two
 * languages, with household measures. It is 87 rows and it will always be too
 * small — real plates carry pita, edamame, chimichurri.
 *
 * This is what the resolver drops to when the curated set has nothing. Rows
 * here are real USDA rows with real citations, so nothing about the
 * traceability guarantee changes: the number still comes from a row we can
 * name, and no model authors it.
 *
 * What *does* change is how much we trust the match, and that is the point of
 * keeping the two tiers apart. Searching loosely across thousands of descriptions is
 * actively dangerous — a substring matcher over this corpus answers "iced tea"
 * with beef sandwich steaks and "grapes" with grapeseed oil, both around ten
 * times the real energy. So a corpus row is never accepted on retrieval score
 * alone; it has to be endorsed by the closed-candidate verifier, and it carries
 * a confidence ceiling and a wider portion interval because nobody curated it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = resolve(HERE, '../../../../data/foods/fdc-corpus.json');

interface RawRow {
  n: string;
  k: number;
  p: number;
  c: number;
  f: number;
  fi: number;
  g?: number[];
  /** Which FDC set the row came from; absent in corpora built before this. */
  d?: string;
}

/**
 * FDC set names, for the citation.
 *
 * Worth the extra words on screen: "USDA FDC 2341234" is checkable, but which
 * set it came from is what tells a reader whether they are looking at a
 * laboratory analysis of an ingredient or a survey row for a whole dish, and
 * those carry different kinds of certainty.
 */
const SET_LABEL: Record<string, string> = {
  sr_legacy: 'SR Legacy',
  survey: 'FNDDS',
  foundation: 'Foundation',
};

export interface CorpusSurface {
  foodId: string;
  text: string;
  tokens: string[];
}

export interface FoodCorpus {
  readonly available: boolean;
  readonly size: number;
  /** Why it is unavailable, for `/healthz`. */
  readonly reason?: string;
  surfaces: ReadonlyArray<CorpusSurface>;
  get(id: string): CanonicalFood | undefined;
}

const EMPTY: FoodCorpus = {
  available: false,
  size: 0,
  reason: 'corpus file not built — run `npm run build:corpus`',
  surfaces: [],
  get: () => undefined,
};

/**
 * Portions USDA records, turned into measures.
 *
 * Deliberately generic units. USDA's portion descriptions are free text ("1
 * stalk, medium (7-1/2\" long)") and mapping them onto this system's canonical
 * vocabulary would be guesswork; the curated tier is where a food earns a real
 * "slice" or "dilim". Here the gram weights are kept and the unit is honest
 * about being unnamed.
 */
function measuresFrom(row: RawRow): HouseholdMeasure[] {
  // An uncurated portion is a weaker claim than a curated one, so it gets a
  // wider spread than anything in the seed.
  const SPREAD = 0.35;
  if (!row.g?.length) return [{ unit: 'portion', grams: 100, spread: 0.4 }];
  const [primary] = row.g;
  return [
    { unit: 'portion', grams: primary ?? 100, spread: SPREAD },
    { unit: 'piece', grams: primary ?? 100, spread: SPREAD },
  ];
}

function toFood(id: string, row: RawRow): CanonicalFood {
  return {
    id: `fdc:${id}`,
    name: row.n,
    names: {},
    aliases: [],
    // Nothing parses USDA descriptions into groups and cooking states reliably,
    // and guessing would let a wrong `state` outrank a curated row. `composite`
    // and `n/a` are the honest "not classified" values, and both are inert:
    // `applyPreparation` leaves `n/a` rows alone rather than boosting them.
    group: 'composite',
    state: 'n/a',
    per100g: { kcal: row.k, proteinG: row.p, carbG: row.c, fatG: row.f, fiberG: row.fi },
    measures: measuresFrom(row),
    composedOf: [],
    source: row.d && SET_LABEL[row.d]
      ? `USDA FDC ${id} (${SET_LABEL[row.d]})`
      : `USDA FDC ${id}`,
  };
}

export function loadFoodCorpus(seedIds: ReadonlySet<string>): FoodCorpus {
  if (!existsSync(CORPUS_PATH)) {
    logger.warn({ path: CORPUS_PATH }, 'food corpus not built; second-tier resolution is off');
    return EMPTY;
  }

  const raw = JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as Record<string, RawRow>;

  // Anything the curated tier already covers is dropped here. Two rows for one
  // food would split retrieval between them and let the uncurated copy — with
  // no aliases, no Turkish, no real measures — win on a technicality.
  const rows = new Map<string, RawRow>();
  for (const [id, row] of Object.entries(raw)) {
    if (!seedIds.has(`fdc:${id}`)) rows.set(id, row);
  }

  const surfaces: CorpusSurface[] = [];
  for (const [id, row] of rows) {
    const text = normalizeText(row.n);
    if (text) surfaces.push({ foodId: `fdc:${id}`, text, tokens: text.split(' ') });
  }

  logger.info(
    { rows: rows.size, shadowed: Object.keys(raw).length - rows.size },
    'food corpus loaded',
  );

  return {
    available: true,
    size: rows.size,
    surfaces,
    get(id) {
      const row = rows.get(id.startsWith('fdc:') ? id.slice(4) : id);
      return row ? toFood(id.startsWith('fdc:') ? id.slice(4) : id, row) : undefined;
    },
  };
}
