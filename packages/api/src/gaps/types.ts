/**
 * The gap taxonomy: what mise did not know, sorted by what would fix it.
 *
 * This is the counterpart to `domain/taxonomy.ts`. That one classifies eval
 * failures against a set someone wrote by hand; this one classifies what real
 * traffic asked for and did not get. The eval set is saturated — every case
 * passes — so it can no longer say what to build next. Production can, and
 * this is the ledger where it says it.
 *
 * The `fix` field is the honest part, and it is why the report separates the
 * two columns rather than dumping one list:
 *
 *   curate  A missing row, alias or household measure. **No amount of
 *           fine-tuning fixes these.** A model cannot be taught the calorie
 *           content of quinoa by gradient descent; the number has to come from
 *           a row someone can cite, which is the whole architecture. These are
 *           data work, and they are usually the larger pile.
 *   train   A judgement the model got wrong when the data was already there —
 *           it split a dish that has its own row, or picked the wrong food
 *           from a shortlist that contained the right one. These are the
 *           examples worth putting in a fine-tune.
 *
 * A record is only a *labelled* training example when the user supplied the
 * answer themselves, which is why corrections are tracked apart from
 * observations. Everything else is a candidate that still needs a human to say
 * what the right output was.
 */
/**
 * `subject` says how the key is built, and it is not a detail.
 *
 * A food phrase groups best after the resolver's own cleaning: "2 kase kinoa"
 * and "kinoa" are one row to write, not two. An identifier must NOT get that
 * treatment — `foodPhraseOnly` strips numeric tokens, so every `fdc:170392`
 * collapsed to the key "fdc" and one line claimed every food's guesses as its
 * own. Anything that is not prose is keyed literally.
 */
export const GAP_TAXONOMY = {
  unknown_food: {
    label: 'No row in either tier',
    detail: 'Retrieval found nothing we would act on, and the corpus did not help',
    fix: 'curate',
    subject: 'phrase',
    owner: 'data/foods',
  },
  uncurated_food: {
    label: 'Answered only from the USDA corpus',
    detail: 'A real citation, but no Turkish name, no aliases and no measures',
    fix: 'curate',
    subject: 'phrase',
    owner: 'data/foods',
  },
  contested_food: {
    label: 'Retrieval could not decide; a model broke the tie',
    detail: 'An alias would make this deterministic and free',
    fix: 'curate',
    subject: 'phrase',
    owner: 'pipeline/resolve',
  },
  corrected_food: {
    label: 'The user overruled the food we picked',
    detail: 'Labelled: the shortlist and the answer are both known',
    fix: 'train',
    subject: 'phrase',
    owner: 'pipeline/resolve',
  },
  unknown_unit: {
    label: 'A measure word we cannot convert',
    detail: 'The count was dropped rather than applied to an unrelated measure',
    fix: 'curate',
    subject: 'literal',
    owner: 'pipeline/normalize',
  },
  guessed_amount: {
    label: 'The portion ladder fell to its last rung',
    detail: 'Nothing could answer the amount, so a default was assumed',
    fix: 'curate',
    subject: 'literal',
    owner: 'data/foods',
  },
  corrected_amount: {
    label: 'The user moved the amount we estimated',
    detail: 'Labelled: our grams and their grams are both known',
    fix: 'train',
    subject: 'literal',
    owner: 'pipeline/portion',
  },
  split_compound: {
    label: 'The extractor split a dish that has its own row',
    detail: 'Labelled: the text and the correct single item are both known',
    fix: 'train',
    subject: 'literal',
    owner: 'pipeline/extract',
  },
  no_food_found: {
    label: 'Text the person meant as a meal, read as nothing',
    detail: 'Needs a human to say what should have come out',
    fix: 'train',
    subject: 'literal',
    owner: 'pipeline/extract',
  },
  missed_item: {
    label: 'A food that was on the plate and never came out',
    detail: 'Labelled: the user named the food and picked its row themselves',
    fix: 'train',
    subject: 'phrase',
    owner: 'pipeline/extract',
  },
} as const;

export type GapKind = keyof typeof GAP_TAXONOMY;
export const GAP_KINDS = Object.keys(GAP_TAXONOMY) as GapKind[];

export const isGapKind = (v: string): v is GapKind => v in GAP_TAXONOMY;

/** Kinds where the user supplied the right answer, so the record is labelled. */
export const LABELLED_KINDS: readonly GapKind[] = [
  'corrected_food', 'corrected_amount', 'split_compound', 'missed_item',
];

export interface GapCandidate {
  foodId: string;
  name: string;
  score: number;
}

/** One thing the pipeline could not do, as it happened. */
export interface GapObservation {
  kind: GapKind;
  /**
   * What the gap is *about*, and therefore what it aggregates by: a food
   * phrase, a unit token, a food id. Chosen per kind so the report groups by
   * the thing you would actually go and fix.
   */
  subject: string;
  /** Verbatim text worth keeping as a training example. */
  sample?: string;
  userId: string;
  /** What we did: the id we chose, the unit we could not convert. */
  observed?: string;
  /** What it should have been, when the user told us. */
  expected?: string;
  /** The closed shortlist a verifier or a user chose from. */
  candidates?: GapCandidate[];
  /** Our mass against theirs. */
  grams?: { estimated: number; corrected: number };
  note?: string;
}

/** Many observations of the same gap, collapsed. */
export interface GapEntry {
  kind: GapKind;
  subject: string;
  hits: number;
  /** Distinct people, from salted hashes. One person's habit is not a trend. */
  users: number;
  firstSeen: string;
  lastSeen: string;
  /** Verbatim spellings, capped. Diacritics and typos are the interesting part. */
  samples: string[];
  observed?: string;
  expected?: string;
  candidates?: GapCandidate[];
  grams?: { estimated: number; corrected: number };
  note?: string;
}
