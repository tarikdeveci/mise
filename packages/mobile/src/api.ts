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
 */

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

export interface Portion {
  gramsLikely: number;
  gramsMin: number;
  gramsMax: number;
  basis: string;
  assumption: string;
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

async function request<T>(path: string, init: RequestInit & { retries?: number } = {}): Promise<T> {
  const { retries = 2, ...rest } = init;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${API_URL}${path}`, {
        ...rest,
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
      lastError = err;
    }

    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, Math.random() * 400 * 2 ** attempt));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new ApiError('network_error', 'Could not reach mise. Check that the API is running.');
}

export const api = {
  logMeal(input: { text?: string; imageBase64?: string; imageMediaType?: string; locale?: string }, key = idempotencyKey()) {
    return request<MealLog>('/v1/meals', {
      method: 'POST',
      headers: { 'Idempotency-Key': key },
      body: JSON.stringify({ locale: 'tr-TR', ...input }),
    });
  },

  history(limit = 20) {
    return request<{ meals: MealLog[] }>(`/v1/meals?limit=${limit}`, { method: 'GET' });
  },

  correct(mealId: string, itemId: string, foodId: string, grams?: number) {
    return request<{ recorded: boolean; hits: number }>(`/v1/meals/${mealId}/corrections`, {
      method: 'POST',
      body: JSON.stringify({ itemId, foodId, ...(grams !== undefined ? { grams } : {}) }),
      retries: 0,
    });
  },

  trace(mealId: string) {
    return request<{ mealId: string; provenance: MealLog['provenance']; items: TraceItem[] }>(
      `/v1/meals/${mealId}/trace`,
      { method: 'GET' },
    );
  },

  health() {
    return request<{
      status: string; extractor: string; foods: number;
      vectorRetrieval: boolean; visionAvailable: boolean;
    }>(
      '/healthz',
      { method: 'GET', retries: 0 },
    );
  },
};
