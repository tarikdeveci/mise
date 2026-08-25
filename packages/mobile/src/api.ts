import { Platform } from 'react-native';

/**
 * API client.
 *
 * Two things here are not boilerplate:
 *
 *  - Every create carries an `Idempotency-Key`. Phones lose connectivity
 *    mid-request constantly, and a user who taps Save twice on a flaky train
 *    must not end up with two breakfasts.
 *  - Retries are bounded and only for transport-level failure. A 400 will not
 *    become a 201 on the third attempt, and a meal log is not worth hammering
 *    a struggling server over.
 *  - Every request has a deadline, and the deadline differs by route. There is
 *    no single correct number: a typed meal answers in milliseconds, while a
 *    photograph of five foods can legitimately spend several seconds per item
 *    at the verifier rung. One flat timeout is wrong in both directions — long
 *    enough for the photo path leaves a dead server spinning for a minute on a
 *    typed one.
 */

/**
 * Per-route deadlines, in milliseconds.
 *
 * These bound the *whole* call including retries, so a request cannot quietly
 * cost three times its stated budget. `PHOTO` is wide because the work behind
 * it is genuinely slow, not because the network might be.
 */
export const DEADLINE = {
  /** Typed text on the rule tier: no network past our own. Server p95 is ~3 ms. */
  TEXT: 15_000,
  /**
   * Typed text when a *model* is doing the extraction.
   *
   * The 15 s above was measured against the rule tier and quietly stopped
   * being true. Running the same text through a model extractor, with the
   * verifier and the corpus rung behind it, measures 7-17 s — and an unknown
   * food is now the *slowest* text case rather than the fastest, because it is
   * the one that reaches every rung. Typing "guacamole" produced a 16.6 s
   * server response against a 15 s client budget: the meal logged, and the
   * person was told it had failed.
   */
  TEXT_MODEL: 40_000,
  /** A photograph: vision extraction, then a verifier call per unresolved item. */
  PHOTO: 45_000,
  /** Reads and lookups. Nothing here is allowed to be slow. */
  QUICK: 8_000,
} as const;

/**
 * Whether the server is extracting with a model, learned from `/healthz`.
 *
 * Cached at module scope because the deadline has to be chosen inside the
 * request helper, several layers below the screen that knows. Until the first
 * health check lands this stays false, which is the safe default: the app
 * calls `health()` when the log screen mounts, well before anything is typed.
 */
let modelExtractor = false;

/** The text deadline that matches whatever this server is actually running. */
const textDeadline = (): number => (modelExtractor ? DEADLINE.TEXT_MODEL : DEADLINE.TEXT);

/** Thrown when a request passed its deadline, and when the user cancelled. */
export class TimeoutError extends Error {
  constructor(readonly cancelled: boolean, ms: number) {
    super(
      cancelled
        ? 'Cancelled.'
        : `mise did not answer within ${Math.round(ms / 1000)}s. It may still be working — check your history before logging again.`,
    );
    this.name = 'TimeoutError';
  }
}

/**
 * Android emulators cannot reach the host's localhost; 10.0.2.2 is the bridge.
 * On a physical device set EXPO_PUBLIC_API_URL to your machine's LAN address.
 */
const DEFAULT_HOST = Platform.select({
  android: 'http://10.0.2.2:3000',
  default: 'http://localhost:3000',
});

export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? DEFAULT_HOST;

/* ─────────────────────────── wire types ─────────────────────────── */

export interface Nutrients {
  kcal: number;
  proteinG: number;
  carbG: number;
  fatG: number;
  fiberG: number;
}

export interface NutritionInterval {
  likely: Nutrients;
  min: Nutrients;
  max: Nutrients;
}

export type PortionMethod =
  | 'user_set' | 'stated_mass' | 'stated_volume' | 'barcode_label' | 'user_memory'
  | 'household_measure' | 'reference_scaled' | 'model_estimate';

export interface Portion {
  gramsLikely: number;
  gramsMin: number;
  gramsMax: number;
  basis: string;
  assumption: string;
  fromVision: boolean;
  /** Which rung of the portion ladder answered. */
  method: PortionMethod;
}

export type ReferenceObject = 'card' | 'coin' | 'utensil' | 'phone' | 'none';

export interface ScannedProduct {
  barcode: string;
  name: string;
  source: string;
  per100g: Nutrients;
  servingGrams: number | null;
}

export interface Confidence {
  overall: number;
  band: 'high' | 'medium' | 'low';
  extraction: number;
  resolution: number;
  portion: number;
  weakest: 'extraction' | 'resolution' | 'portion';
}

export interface Candidate {
  foodId: string;
  name: string;
  score: number;
  via: string;
}

export interface FoodSearchHit {
  foodId: string;
  name: string;
  localizedName?: string;
  source: string;
  kcalPer100g: number;
  score: number;
  tier: 'curated' | 'reference';
}

export interface LoggedItem {
  id: string;
  extracted: { phrase: string; quantity?: number; unit?: string; preparation: string; confidence: number };
  resolution: { method: string; foodId: string | null; candidates: Candidate[]; margin: number };
  foodId: string | null;
  foodName: string | null;
  source: string | null;
  portion: Portion | null;
  nutrition: NutritionInterval | null;
  confidence: Confidence;
}

export interface Question {
  itemId: string;
  question: string;
  options: Array<{ label: string; foodId: string | null; grams: number | null }>;
  expectedKcalSwing: number;
}

export interface MealLog {
  id: string;
  status: 'confirmed' | 'needs_review' | 'needs_input';
  items: LoggedItem[];
  totals: NutritionInterval;
  questions: Question[];
  provenance: {
    pipelineVersion: string;
    promptVersion: string;
    extractorId: string;
    model: string;
    traceId: string;
    latencyMs: number;
  };
  createdAt: string;
}

export interface TraceItem {
  phrase: string;
  resolution: { method: string; margin: number; consideredCandidates: Candidate[] };
  portion: Portion | null;
  arithmetic: string | null;
  source: string | null;
  confidence: Confidence;
}

export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly traceId?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

/* ──────────────────────────── transport ─────────────────────────── */

const USER_ID = 'demo-device';

function idempotencyKey(): string {
  // A per-attempt key would defeat the point; this one is generated once per
  // user intent and reused across retries of that same intent.
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface RequestOptions extends RequestInit {
  retries?: number;
  /** Whole-call budget, retries included. Defaults to `DEADLINE.QUICK`. */
  timeoutMs?: number;
  /** Lets a screen cancel in flight — a Cancel button, or unmount. */
  signal?: AbortSignal;
}

async function request<T>(path: string, init: RequestOptions = {}): Promise<T> {
  const { retries = 2, timeoutMs = DEADLINE.QUICK, signal: external, ...rest } = init;
  const deadlineAt = Date.now() + timeoutMs;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    // The deadline covers the whole call, so a retry never buys itself a fresh
    // budget. Without this, `retries: 2` silently triples the stated timeout.
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new TimeoutError(false, timeoutMs);
    if (external?.aborted) throw new TimeoutError(true, timeoutMs);

    const controller = new AbortController();
    const expire = setTimeout(() => { controller.abort(); }, remaining);
    const relay = (): void => { controller.abort(); };
    external?.addEventListener('abort', relay);

    try {
      const res = await fetch(`${API_URL}${path}`, {
        ...rest,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': USER_ID,
          ...(rest.headers ?? {}),
        },
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: { code?: string; message?: string; traceId?: string } }
          | null;
        const err = new ApiError(
          body?.error?.code ?? `http_${res.status}`,
          body?.error?.message ?? `Request failed (${res.status})`,
          body?.error?.traceId,
        );
        // Client errors are final: retrying a rejected body just wastes the
        // user's battery and hides the bug.
        if (res.status < 500 && res.status !== 429) throw err;
        lastError = err;
      } else {
        return (await res.json()) as T;
      }
    } catch (err) {
      if (err instanceof ApiError && !String(err.code).startsWith('http_5')) throw err;
      // An abort is not a transport failure to retry through: either the user
      // asked us to stop, or the budget is gone. Both are final, and both need
      // to read differently to the person holding the phone.
      if (controller.signal.aborted) throw new TimeoutError(external?.aborted === true, timeoutMs);
      lastError = err;
    } finally {
      clearTimeout(expire);
      external?.removeEventListener('abort', relay);
    }

    if (attempt < retries) {
      // Full jitter, but never past the deadline: sleeping through the budget
      // and then reporting a timeout wastes the user's wait on nothing.
      const backoff = Math.min(Math.random() * 400 * 2 ** attempt, deadlineAt - Date.now());
      if (backoff > 0) await new Promise((r) => setTimeout(r, backoff));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new ApiError('network_error', 'Could not reach mise. Check that the API is running.');
}

export const api = {
  logMeal(
    input: {
      text?: string;
      imageBase64?: string;
      imageMediaType?: string;
      locale?: string;
      /** Scanned package: the one route with no model anywhere in it. */
      barcode?: string;
      /** A scale reference the user put in frame, if any. */
      reference?: ReferenceObject;
    },
    key = idempotencyKey(),
    signal?: AbortSignal,
  ) {
    return request<MealLog>('/v1/meals', {
      method: 'POST',
      headers: { 'Idempotency-Key': key },
      body: JSON.stringify({ locale: 'tr-TR', ...input }),
      // A photo is slow for a legitimate reason; typed text is not allowed to be.
      timeoutMs: input.imageBase64 ? DEADLINE.PHOTO : textDeadline(),
      ...(signal ? { signal } : {}),
    });
  },

  /** Look up a scanned package without logging it, so the user can confirm. */
  scan(code: string) {
    return request<ScannedProduct>(`/v1/barcode/${encodeURIComponent(code)}`, {
      method: 'GET',
      retries: 1,
    });
  },

  history(limit = 20) {
    return request<{ meals: MealLog[] }>(`/v1/meals?limit=${limit}`, { method: 'GET' });
  },

  /** Search the verified food vocabulary before correcting one meal item. */
  searchFoods(query: string, signal?: AbortSignal) {
    return request<{ query: string; foods: FoodSearchHit[] }>(
      `/v1/foods/search?q=${encodeURIComponent(query)}&limit=8`,
      { method: 'GET', retries: 0, timeoutMs: DEADLINE.QUICK, ...(signal ? { signal } : {}) },
    );
  },

  /**
   * Record a correction, and get the meal back with it already applied.
   *
   * Two effects, one call. `grams` populates the `user_memory` rung, so next
   * time this phrase appears the portion is replayed rather than estimated —
   * and the returned `log` is this meal, same id, same item ids, recomputed.
   * The screen renders that directly instead of re-logging the meal to see its
   * own correction, which used to lose photographs and reset every question.
   *
   * Either half may be omitted: a food with no amount, or an amount on the
   * food the item already resolved to.
   */
  correct(mealId: string, itemId: string, foodId?: string, grams?: number) {
    return request<{ recorded: boolean; hits: number; log: MealLog }>(
      `/v1/meals/${mealId}/corrections`,
      {
        method: 'POST',
        body: JSON.stringify({
          itemId,
          ...(foodId !== undefined ? { foodId } : {}),
          ...(grams !== undefined ? { grams } : {}),
        }),
        retries: 0,
      },
    );
  },

  /**
   * Adds a food the meal was logged without, and gets the meal back with it in.
   *
   * `correct` can only reach lines that already exist. When mise reads four
   * items off a plate that had five, nothing on the screen is wrong — one
   * thing is simply absent — and this is the only way to say so without
   * logging the meal a second time.
   */
  addItem(mealId: string, foodId: string, opts: { grams?: number; phrase?: string } = {}) {
    return request<{ added: boolean; itemId: string; log: MealLog }>(
      `/v1/meals/${mealId}/items`,
      {
        method: 'POST',
        body: JSON.stringify({
          foodId,
          ...(opts.grams !== undefined ? { grams: opts.grams } : {}),
          ...(opts.phrase !== undefined ? { phrase: opts.phrase } : {}),
        }),
        retries: 0,
      },
    );
  },

  trace(mealId: string) {
    return request<{ mealId: string; provenance: MealLog['provenance']; items: TraceItem[] }>(
      `/v1/meals/${mealId}/trace`,
      { method: 'GET' },
    );
  },

  async health() {
    const h = await request<{
      status: string; extractor: string; foods: number;
      vectorRetrieval: boolean; visionAvailable: boolean;
    }>(
      '/healthz',
      { method: 'GET', retries: 0 },
    );
    // The rule tier is the only extractor that answers in milliseconds, and it
    // is the only one that names itself "rules". Everything else is a network
    // round trip to a model and needs the wider budget.
    modelExtractor = !h.extractor.startsWith('rules');
    return h;
  },
};
