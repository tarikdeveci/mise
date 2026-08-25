# mise

Meal logging that turns messy input into canonical foods, portions and nutrition, and is honest about how sure it is.

Built for the EatBetter Full Stack case study. Node.js / TypeScript backend, Expo (React Native) app.

---

## The one-paragraph version

Every calorie figure this system displays is `per100g × grams ÷ 100` over a row in a food database. No model ever writes a nutrition number, and no model ever names a food ID: the extractor describes what it sees in words, and a resolver maps those words to a canonical row by a ladder of increasingly expensive strategies, stopping at the first one that answers decisively. 96.5% of resolutions on the test set never touch a model at all. What the model *is* used for is the part that genuinely needs judgement, and even there it chooses from a closed candidate list rather than generating an identifier. The result is a system where hallucinated nutrition is not rare, it is structurally impossible, and where the same words logged twice cannot produce two different answers.

A photograph is the case that does still vary, and I would rather say so here than bury it: the vision model's *wording* changes between runs, the wording is what gets resolved, and two consecutive runs of one JPEG in this repository read 736 and 865 kcal. What does not vary is the arithmetic, the citation, or the honesty of the range — each of those figures sits inside the interval the other run displayed. [Where this is weak](#where-this-is-weak) has the measurement.

The second commitment is the portion interval. Nutrition5k measured trained dietitians at ~41% average error estimating portions from images, so a single-figure calorie count is precision the evidence does not support. mise carries min/likely/max through the whole pipeline and shows the range in the UI. On the current test set the true total falls inside the displayed range 100% of the time.

The amount question gets the same treatment as the identity question: a second ladder that routes it to the cheapest method able to answer *exactly* — a stated mass, a scanned label, a portion this person confirmed before, a card left in frame for scale — and only falls through to a model estimate when nothing else can answer. The rung that answered is shown next to every item with its own tolerance, so the width of the range is explained rather than merely displayed.

---

## Run it

Requires Node 22+.

```bash
npm install
```

Start the API (no API key needed, the default extractor is deterministic):

```bash
npm run dev
```

Run the accuracy evaluation:

```bash
npm run eval
```

Run the photo cases (needs a vision key; see the model line at the end of this section):

```bash
npm run eval:photos
```

Start the app — Expo Go on a phone, or an Android emulator / iOS simulator:

```bash
npm run mobile
```

This is a native app rather than a web page, which is what the brief asked for: React Native through Expo, with the platform camera and image picker. Verified end to end on an Android emulator (API 36) and on Expo Go. Metro will also serve it in a browser with `w` — that is a convenience for reviewing it quickly, not the target.

On a physical device, point the app at your machine:

```bash
EXPO_PUBLIC_API_URL=http://192.168.1.x:3000 npm run mobile
```

To use a hosted model instead of the rule tier, set one key and one env var:

```bash
GOOGLE_API_KEY=... EXTRACTOR=gemini npm run dev
```

---

## Current numbers

`npm run eval` on 46 labelled cases, rule extractor, vector retrieval on (see the [bake-off](#model-choice-is-an-eval-output-not-an-opinion) for the model tier):

| | |
|---|---|
| exact pass rate (no taxonomy error of any kind) | 100% |
| food match accuracy (correct canonical id) | 100% |
| kcal median APE | 0% |
| kcal within ±10% | 93% |
| **interval coverage** (truth inside the range shown) | **100%** |
| **hallucination rate** | **0%** |
| deterministic resolutions (no model call) | 96.5% |
| auto-logged (needed no user input) | 43.5% |
| precision when auto-logged | 100% |
| calibration error (ECE) | 0.2066 |
| latency p50 / p95 | 0 ms / 3 ms |

**Read that 100% as a warning, not a result.** See [Where this is weak](#where-this-is-weak) before believing any of it. The eval tool prints the same warning itself.

`npm test` — 215 unit and integration tests, no key and no network required.

`npm run eval:photos` on five real meal photographs, Gemini vision:

| | |
|---|---|
| items extracted across 5 photos | 21-22 |
| **invented** (a food reported that is not in the picture) | **0** |
| declined (named in the picture, in neither database tier) | 2 |
| photos auto-logged without asking the user anything | 0 of 5 |
| latency per photo | 3.5-18.5 s |

The item count is a range because two consecutive runs of the same five files
disagree about what they are looking at. That is the honest headline of this
table and it is discussed in [Where this is weak](#where-this-is-weak).

Before the USDA corpus tier existed the same five photographs produced 23 items of which **17** were declined — honest, and nearly useless. That is the change worth reading in this table, and it is a data change, not a model one.

Those are the figures a photograph can settle. Calorie accuracy is not among them, and the reason is in [Where this is weak](#where-this-is-weak).

---

## The problem, as I understand it

"Convert messy input into correct canonical foods + portions + nutrition with high confidence, and be robust to ambiguity."

Four things make that hard, and they fail independently:

1. **Identification** — which food is this? "yogurt" is plain, Greek, or fruit: 61 to 99 kcal/100g.
2. **Portion** — how much of it? This is where most calorie error actually lives, and it is the part a camera fundamentally cannot solve: it cannot see the oil in the pan, the sugar in the sauce, or how deep the bowl is.
3. **Preparation** — boiled potato is 87 kcal/100g, fried is 312. Same food, 3.6×.
4. **Knowing when you don't know** — and doing something useful with that instead of printing a confident number.

The published evidence is not encouraging on any of them. General-purpose VLMs average around 60% precision on food ingredient recognition; one leading model was documented reading cream as milk, a 380 kcal error. An independent 180-meal validation found that manual-plus-barcode workflows beat photo-only AI apps *as a class*. And the accuracy ceiling for humans is low too, which is the finding that shaped this design most: if dietitians average 41% portion error, then no honest system should display a single number.

So mise does not try to sell photo magic. It tries to be **fast, honest, and correctable**.

---

## Architecture

```
MealInput (text and/or photo)
   │
   ├─ 1  normalize      pure, deterministic: Turkish/English folding, unit and
   │                    quantity parsing, light stemming for both languages
   │
   ├─ 2  extract        the ONLY stage a model authors anything, and it may only
   │                    describe: phrase, quantity, unit, preparation, confidence.
   │                    No nutrition. No food IDs. Schema-enforced.
   │
   ├─ 3  expand         recipe templates for dishes with no database row
   │                    ("tost" → bread + kaşar), before resolution
   │
   ├─ 4  resolve        the router — see below
   │
   ├─ 5  portion        the ladder — see below. Returns an INTERVAL, and the
   │                    width is set by which rung answered
   │
   ├─ 6  compute        arithmetic over the database row. No judgement, no model.
   │
   └─ 7  confidence     decomposed per stage, so a low score is actionable
                        │
        correction ─────┘  user fixes a match → stored as a deterministic alias
```

Each stage is a pure function with its own tests. The boundaries are where the guarantees live: because stage 6 is the only thing that can produce a nutrition figure, and it can only read from the database, "the AI invented a calorie count" is not a failure mode this system has.

### The resolution router

This is the central design decision. Most food phrases are easy, and paying a model to confirm that is waste, so resolution is a ladder that stops at the first rung to answer decisively:

| rung | cost | when it fires |
|---|---|---|
| 1. user alias | ~0 ms | this person already corrected this exact phrase |
| 2. global alias | ~0 ms | a curated default for a known-ambiguous bare term |
| 3. lexical | ~1 ms | decisive string match (IDF-weighted tokens + trigram Dice) |
| 4. lexical + vector | ~15 ms | decisive after multilingual embedding retrieval |
| 5. LLM verify | ~800 ms | plausible but not self-evident, or genuinely contested |
| 6. USDA corpus | ~800 ms | nothing curated fits, so search all 13,339 reference rows — verifier-gated |
| 7. corpus choices | ~1 ms | no verifier available: show the closed shortlist, accept nothing yet |
| 8. unresolved | — | ask the user one targeted question |

The escalation signal is the **margin** between the top two candidates, not the top score. A 0.9 top score with a 0.02 gap means two foods look equally likely, which is exactly when a model is worth paying for and when the user is worth interrupting.

Margin alone turned out not to be enough, and real photographs are what showed it. Retrieval always returns *something*, so a decisive margin proves only that the runner-up was worse — not that the winner is right. `"sesame seeds"` beat everything else to **tahini** uncontested and became the only item logged for a large bowl of noodles; `"spinach and cheese filling"` resolved to **börek**, a pastry. Both had a clear margin over nothing in particular.

So rung 4 now needs an absolute score as well as a margin (`SELF_EVIDENT_SCORE = 0.72`). Below that a winner is *verified* rather than accepted, which is what rung 5 was always for: the model is asked one narrow question — is this candidate genuinely the same food — and is allowed to answer "none of these". A verifier that cannot be reached fails **closed**: it sends the item to the user rather than becoming an approver.

Two properties fall out of this that matter more than the latency saving:

- **Determinism.** Rungs 1–4 are pure functions, and the model tier runs at `temperature: 0`. Re-scanning the same meal cannot return a different number. This is a documented, reproducible failure of shipped competitors and it is simply not a failure we need to have.
- **Bounded hallucination.** Rung 5 receives a *closed* candidate list. The reranker's schema constrains it to an ID from that list or an abstention; a reply outside the set is dropped and the item falls through to asking the user. It is not "the model usually behaves", it is "the model has no other move available".

**Rung 6 is a second database tier, and it is only safe because a verifier — model or human — must endorse it.** The curated seed is 121 rows — two languages, aliases, household measures — and it will always be too small: real plates carry pita, edamame, chimichurri. Behind it sit **13,339 USDA reference rows**, built from three of FoodData Central's sets:

| set | what it is | rows here |
|---|---|---|
| SR Legacy (2018) | ingredients, analysed — "Avocados, raw" | 7,793 |
| FNDDS Survey (2021-23) | **dishes people report eating** — guacamole, sushi, pad thai | 5,331 |
| Foundation (2025) | few rows, deepest analysis, newest data | 215 |

FDC is not one database, and wiring only the first of those left a hole shaped exactly like a real meal. SR Legacy carries four avocado rows and **no guacamole**, because a dish is not an ingredient — so a plate of real food kept falling through to a question the user could not answer either. FNDDS is the set that closes that, and it is why `"guacamole"` now resolves to `Guacamole, NFS` at 155 kcal/100 g with a citation instead of to an apology. **Branded Foods is deliberately excluded**: it is roughly two million packaged products and several gigabytes, and the barcode rung already answers that question exactly, off a label, without retrieval guessing at it.

What makes a wide corpus usable is that it is never accepted on a retrieval score. Searching loosely across thousands of loosely-worded descriptions produces confident nonsense — a plain matcher over this corpus answers `"iced tea"` with beef sandwich steaks and `"grapes"` with grapeseed oil, both around ten times the real energy, and both perfectly plausible in a log. The curated tier is protected from that by being eighty-odd rows a person read; this one has no such protection, so every corpus match needs a verifier. With a model verifier the chosen row can proceed at capped confidence. Without one, mise returns the shortlist as a question and keeps calories blank until the user taps a row. That preserves coverage during provider outages without quietly turning retrieval into nutrition. Both probes still behave after the corpus grew by 71%: `"grapes"` resolves to *Grapes, raw*, and `"iced tea"` is declined outright.

A corpus match is a real USDA citation, so nothing about traceability changes — but nobody curated it, and the pipeline says so rather than hiding it: a confidence ceiling of 0.6 that keeps it out of the auto-logged set, a wider portion interval because there are no household measures, and a line in the gap ledger. `uncurated_food` is the highest-value curation queue this system has: each row is a food real people ate, already matched to the USDA row somebody would have to find anyway.

FDC descriptions are English. A small explicit query bridge covers common Turkish spellings (`kinoa → quinoa`, `kuskus → couscous`, `suşi → sushi`, `guakamole → guacamole`, `pad tay → pad thai`, `lazanya → lasagna`). It changes retrieval text only: the returned row still needs the same verifier, so localization cannot manufacture nutrition.


### The portion ladder

Identity and amount are two different questions, and the amount is the one that dominates the error. So it gets the same treatment: a ladder that routes the question to the cheapest method able to answer it *exactly*, rather than sending everything to a model that estimates.

| rung | typical band | when it fires |
|---|---|---|
| 1. stated mass | ±2% | "180 g tavuk". Arithmetic, nothing to estimate |
| 2. stated volume | ±5% | "1,5 litre süt", through the food's own density |
| 3. barcode label | ±8% | a scanned package states its serving |
| 4. user memory | ±10% | this person confirmed their portion of this before |
| 5. reference scaled | ±18% | a photo with a card or coin in frame for scale |
| 6. household measure | ±5-50% | "2 dilim", "bir kase" — the food's *own* measure spread, because a slice of bread varies far less than a bowl of soup |
| 7. model estimate | ±40% | a photo, no reference, no stated amount. The hard case |

Every rung returns `null` rather than guessing, so falling through is a real decision and not an accident.

Above all seven sits the one thing no ladder can derive: the person telling us. Every item in the app carries a gram field, and both ends of its range are one tap from becoming the answer — so a range is something you can close rather than only something you are shown. A hand-set amount is recorded as `user_set` (±5%: asserted, not weighed), applied to the meal on screen, and remembered as this user's usual for that wording, which drops the same phrase onto rung 4 next time. This is deliberately *not* a rung: rungs answer "what can be worked out from what we were given", and a correction is not an inference.

The evidence behind the ordering is why it is shaped this way rather than "ask a better model":

- Nutrition5k reports **9.5% error predicting kcal per gram against 26.1% predicting total calories** from the same image. The model is far better at *what this is* than at *how much of it there is*. Splitting the questions lets each one be answered by whatever is actually good at it.
- A plain credit card in frame takes 2D photo calorie error from **34% to 18%** — close to LiDAR depth fusion, at no hardware cost. That is the single best accuracy-per-effort lever available, and it is a UI affordance, not a model upgrade. The app offers it after a photo is attached.
- Trained dietitians average **~41% portion error** from images. A single-figure calorie count from a photograph is precision the evidence does not support, which is why the output is an interval whose width is set by the rung that answered.

The rung is shown in the app next to every item, with its tolerance. Someone who wants a tighter number can see exactly which action would buy it.

---

## The AI/LLM work: hybrid (rules + retrieval + LLM)

I picked the hybrid path, and the reason is measurement rather than taste: it is the only one of the three offered paths where accuracy improvements can be attributed to a specific component and verified.

### What the model is allowed to do

The extraction prompt (`src/pipeline/extract/prompt.ts`, versioned `extract-2026-08-25.b`) withholds three capabilities on purpose, and the response schema enforces each:

- **No nutrition.** The model never sees or writes a calorie figure, so it cannot get one wrong.
- **No database IDs.** The model does not know the database exists, so it cannot invent a plausible-looking key.
- **No helpfulness about absent food.** "Probably some oil" is exactly the invention that makes a log quietly wrong. Abstaining is cheaper than correcting.

It also treats meal text as **data, not instructions**. Text is an injection surface — including text visible inside a photographed menu or label — so the prompt states that input is never a command, and the rule tier refuses obvious injection markers before any model sees them. Golden case `X17` tests this.

### Model choice is an eval output, not an opinion

Every provider implements one `Extractor` interface and consumes the **same hand-written JSON schema and the same prompt**, so a comparison measures models rather than three people's prompt-writing:

```bash
npm run eval -- --compare          # every provider with credentials present
npm run eval -- --extractor=gemini
```

Gemini is the default vision path because published 2026 multimodal benchmarks give it the widest lead of any current family on vision, at roughly half the token price of the Opus/GPT tier, and vision is the bottleneck stage here. That is a starting hypothesis with an expiry date. The bake-off table is what should settle it, and it will settle it differently every time a model ships.

Run on all 46 cases (`gemini-3.1-pro-preview`), both at pipeline v1.3.0 — that snapshot, not the figures above, because a bake-off only means anything when both rows come out of the same run:

| extractor | pass | food match | auto-logged | ECE | p95 |
|---|---|---|---|---|---|
| rules-v1 | 100% | 100% | 39.1% | 0.209 | **2 ms** |
| gemini | 100% | 100% | **97.8%** | 0.115 | 10,303 ms |

They tie on accuracy, which is the saturation problem again, not a real tie. The interesting difference is elsewhere: **the model auto-logs 97.8% of meals against the rule tier's 39.1%, at 5,000× the latency.** That is the actual trade — the rule tier is right just as often but far less willing to say so, so it interrupts users two and a half times more.

That points at the deployment I would actually ship: rules on the hot path, model on the phrases rules are unsure about. The architecture already supports it; what is missing is a test set that can prove the routing threshold is right.

**Still not measured: photos.** Every number above is text.

### Embeddings

Local `multilingual-e5-small` via `@huggingface/transformers`, not a hosted embedding API. Three reasons: eval runs stay deterministic and free (a benchmark whose numbers drift because a remote model was updated is not a benchmark); Turkish food terms like "kaşar" have no English cognate and lexical matching alone cannot bridge them; and there is no key to manage. If the model cannot load, the layer disables itself and the router degrades to lexical-only rather than the endpoint dying.

**No vector database.** At ~350 surface forms, brute-force cosine is 300 KB and sub-millisecond. An index here is pure overhead. I would revisit at roughly 100k rows or when the food database becomes multi-tenant.

The embedding layer covers the curated tier only. The 13,339-row corpus is searched lexically, because that rung's safety comes from the verifier rather than from the retrieval score, and embedding that many loosely-worded USDA descriptions would buy recall in exactly the place where more recall is the risk.

---

## How accuracy is measured

The eval harness is the part of this submission I would defend hardest. An accuracy number without one is a scalar that moves for unknown reasons.

### The test set

46 labelled cases in `data/golden/cases.json`, stratified:

- **easy** (12) — explicit quantities, unambiguous foods
- **ambiguous** (16) — how people actually type: "yogurt", "chicken and rice", "bir avuç badem"
- **adversarial** (18) — built to break specific things: the cream/milk trap from the literature, raw vs cooked rice (365 vs 130 kcal/100g), Turkish-only terms, non-food input, prompt injection, "I didn't eat anything"

Labels are `(foodId, grams)` pairs only. **Expected calories are computed from the database, never hand-written** — a hand-typed expected value can disagree with the database it describes, and then the benchmark measures the labeller's arithmetic instead of the system. A label can be wrong about *which food* or *how much*, which are reviewable claims; it cannot be wrong about what those two imply.

Every case also records what it *probes* and which error codes it is designed to catch, so a failure explains itself.

**Five photo cases** in `data/golden/photos.json`, scored separately and on different terms. They record what each picture is, which foods the database *should* be able to name, which ones it honestly cannot, and — the field that matters most — the **invisible calories**: the frying oil, the creamy dressing, the chimichurri that is mostly oil and looks like herbs. Naming those per case makes the systematic undercount visible instead of silently absorbed. `npm run eval:photos` prints them next to what the system actually returned, and asks you to read the two against the picture yourself.

### Metrics, and why each one is there

- **Food match accuracy** — did we hit the right canonical row.
- **kcal median APE, % within ±10 / ±25** — the number users feel.
- **Interval coverage** — how often the truth landed inside the range we displayed. This is what makes the honesty claim falsifiable rather than decorative.
- **Auto-log rate and precision-when-auto-logged, reported separately** — because accuracy can always be bought with coverage. Keeping them apart makes the exchange rate an explicit product decision instead of an accident of thresholds.
- **ECE / reliability bins** — whether the confidence number means anything. If items scored 0.9 are right 60% of the time, the score is a mood, and routing built on it is arbitrary.
- **Deterministic share** — what fraction of traffic avoided a model entirely. The cost story.
- **Hallucination rate** — must be 0. `npm run eval` exits non-zero if it is not.

### Error taxonomy

Twelve codes, each mapped to the component that can fix it, so a regression points at a directory rather than at "the AI":

| code | what it means | owner |
|---|---|---|
| E1 | wrong canonical food | `resolve/` |
| E2 | item present but not extracted | `extract/` |
| E3 | item extracted but not present | `extract/` |
| E4 | right food, wrong mass | `portion/` |
| E5 | unit or conversion error | `portion/` |
| E6 | wrong cooking state | `resolve/` |
| E7 | brand/generic confusion | `resolve/` |
| E8 | composite dish not decomposed | `resolve/` |
| E9 | double counting | `extract/` |
| E10 | language/locale failure | `resolve/` |
| E11 | nutrition not traceable to a database row | `nutrition/` |
| E12 | non-food input accepted as food | `extract/` |

E11 is special: it is asserted at runtime, not only in tests. `verifyTraceable()` recomputes every displayed figure from its own food row on every request; if it ever disagrees, the item is degraded to unresolved rather than shown. That turns "we don't hallucinate nutrition" from an argument into an assertion that can fail the build.

### Iterating quickly and safely

The rule tier runs with no key, no network and no variance, so the whole regression suite is free and deterministic in CI. `pipelineVersion`, `promptVersion`, `extractorId` and `model` are recorded on every meal log, so any accuracy change can be attributed. A prompt edit that drops a metric is visible in one command.

### What the eval actually caught

Every one of these would have shipped silently. They are listed because the point of an eval is not the score it prints, it is the defects it surfaces:

1. **`"180g"` parsed as one token.** The unit was invisible, so the quantity multiplied a household measure: 180 × 120 g = 21.6 kg of chicken, reported as 35,640 kcal.
2. **`\b` is ASCII-only in JavaScript.** `\büzerine\b` never matched real Turkish text, so "ekmek üzerine tereyağı" stayed one fragment and the butter was silently dropped.
3. **The Turkish hedge `"az"` matched inside `"bey-az"`.** Substring matching turned "2 dilim beyaz ekmek" into an unquantified amount and halved it to one slice. This one was caught by the HTTP integration test, not the eval — the golden set happened not to contain a quantified "beyaz ekmek", which is a good argument for having both.
4. **A Fastify 400 was reported as a 500.** Clients were told the server was broken and to retry, when the request was what needed fixing — and real incidents were hidden in the same bucket.
5. **The router threw away the extractor's `preparation` field.** This is the one I would not have found without the bake-off, and it is the most interesting bug here. A well-behaved extractor *lifts* preparation out of the phrase into its own field, so the router received `"yumurta"` where the user wrote `"haşlanmış yumurta"` — and the alias fast-path resolved it to raw egg. Boiled egg → raw egg, fried chicken → grilled breast, raw rice → cooked rice (365 vs 130 kcal/100g, a 64% error). The rule tier hid it completely, because it leaves the preparation word in the phrase for the lexical matcher to find. **The bug only appeared when a model did its job properly.** Fixing it took Gemini from 91.3% to 100% and changed no rule-tier number at all.

6. **A decisive margin was being read as a correct match.** Found by running real photographs, and described under [the resolution router](#the-resolution-router): `"sesame seeds"` → tahini was the *only* item logged for a bowl of noodles. Fixed by requiring an absolute score as well as a margin, and sending everything below it to the verifier.

7. **2,380 g of pasta, and the arithmetic was correct the whole way.** A photo of stuffed shells produced "17 pieces". Pasta has no `piece` measure, so the count fell through to the default 140 g cup: 17 × 140 = 2.4 kg, 3,478 kcal, internally consistent at every step. The fix is not better reasoning, it is a bound — a count whose stated unit is undefined for that food is refused, and any single item over 1.2 kg is rejected outright. That meal went from 3,478 to 543 kcal.

8. **`"tatlı"` was listed as a unit, and it ate the word "sweet".** The worst defect in this codebase, and the one nothing was watching for. `tatlı` was shorthand for `tatlı kaşığı`, the dessert spoon — so the phrase cleaner stripped it as a measure word, and **"tatlı patates" (sweet potato) reached the router as "patates"**. That exact-matched the potato row at score 1.0 on the *deterministic* rung: a confident, reproducible, roughly 2× energy error on a common Turkish ingredient. Every defence in the system was in place and none of them fired, because the error happened in the cheapest tier before any of them ran. The fix is one line — list the dessert spoon in full, as the other Turkish spoon measures already were — and the regression test pins the score so a database edit cannot promote it back into the fast path.

9. **The app claimed `±0%` where the pipeline said `±8%`.** The scan screen advertised "Nothing estimated" for a barcode, while the barcode rung had always carried an 8% spread. The pipeline was right — a printed serving is an exact number, but "I ate one serving" is not a measurement, and declared nutrients carry labelling tolerance. Found by writing the first test that ever covered the barcode route. Rounding in our own favour on the one screen that sells this product on honesty was the worst available place to do it.

Turkish is agglutinative, so "çay", "çayın", "çaydan" are one food to a person and three strings to a matcher. A light stemmer (one suffix maximum, never below a 3-letter stem) fixed a class of silent misses. Over-stemming would collapse genuinely different foods, which is worse than missing an inflection, hence the conservatism.

---

## Reliability

- **Idempotency.** `POST /v1/meals` accepts an `Idempotency-Key` and stores a hash of the body with it. Replays return the original log; the same key with a *different* body returns 409 rather than silently serving a stale result, because that is a client bug and hiding it helps nobody. Phones lose connectivity mid-request and users tap Save twice; without this, "the network dropped" and "the meal was logged twice" are the same observable event.
- **Retries with full jitter**, both client and server side. Jitter is not a detail here: meal traffic is extremely peaky, three sharp spikes a day at the same clock times for everyone, so a synchronised retry storm is the realistic failure mode. The client retries transport failures only — a 400 will not become a 201 on the third attempt.
- **A ceiling on every outbound call** (30 s extraction, 10 s verification, 8 s barcode). Retrying does nothing against a request that never returns, and one measured for real took 623 s. A hang is classified as retryable, so the second attempt is a fresh connection rather than a longer wait on a dead one.
- **Deadlines, per route and per whole call.** A typed meal answers in milliseconds; a photo of five foods can legitimately spend tens of seconds at the verifier rung. One flat timeout is wrong in both directions, so the client carries a deadline per route that covers the *whole* call including retries — otherwise `retries: 2` silently triples the stated budget. The server's own `requestTimeout` sits above the client's, so the phone gives up first and gets the better error message, and a hung upstream cannot hold a socket until restart.
- **The text deadline follows the extractor, and that is a bug I shipped once.** 15 s was measured against the rule tier and quietly stopped being true: run the same typed meal through a model extractor with the verifier and corpus rung behind it and it takes 7-17 s, because an unknown food is now the *slowest* text case rather than the fastest — it is the one that reaches every rung. Typing "guacamole" on the emulator produced a 16.6 s server response against a 15 s client budget: the meal logged, and the person was told it had failed. The client now reads `/healthz` and takes 40 s when a model is doing the extraction, 15 s when the deterministic tier is.
- **A cancellable wait.** While a request is in flight the app offers Cancel. A long wait and an inescapable wait are different problems, and only one of them is defensible.
- **Graceful degradation, observed rather than asserted.** If the embedding model cannot load, the router runs lexical-only. If a provider is down, the endpoint falls back to the rule tier: text logging keeps working and the user sees "worth a look" instead of an error. If the verifier is unreachable it fails **closed** — the item goes to the user rather than being accepted unchecked — and a verifier that throws costs that item its verification, not the whole meal.

  I got to watch all of that fire for real: mid-session the provider started returning `429 quota exceeded`. Extraction retried twice, logged `extractor failed, degrading to rule tier`, and carried on; the verifier retried, logged `reranker unavailable`, and declined to endorse anything. The corpus still returned a closed shortlist, but calories stayed blank until the user selected a real row. The meal came back asking rather than guessing or erroring. That is the whole design working in the one condition nobody schedules.
- **Typed error envelope.** Every failure returns `{ error: { code, message, traceId } }`. Stack traces and provider errors stay in the log; the message is safe to display.

## Observability

- **Structured logs** (pino) with `traceId` on every line. Meal text and images are **redacted at the logger** — they are health data, the text can name a medication and a photo can contain a face or a prescription on the table, and logs are the easiest place for that to leak into a system nobody classified as sensitive.
- **Metrics** at `GET /metrics`, chosen so each one answers a decision: resolution method distribution (what fraction avoided a model), stage latency histograms (what to optimise), confidence band counts (how much we are interrupting people), LLM cost per log (what breaks at scale), and counters for reranker illegal choices and untraceable nutrition.
- **`GET /v1/meals/:id/trace`** — the provenance endpoint. For every item it returns the extracted phrase, the resolution method and margin, every candidate that was considered with its score, the portion assumption, the literal arithmetic, and the source citation:

```
2 dilim ekmek → global_alias | 265 kcal/100g x 56 g / 100 = 148.4 kcal | USDA FDC 172687
peynir        → global_alias | 264 kcal/100g x 25 g / 100 = 66 kcal   | USDA FDC 173420
çay           → global_alias | 1 kcal/100g x 110 g / 100 = 1.1 kcal   | USDA FDC 173175
```

The same information is one tap away in the app.

---

## What mise does not know

The golden set is saturated — every case in it passes — so it can no longer say what to build next. Production can. Every time the pipeline fails to answer something, it writes down *what it was asked*, and `npm run gaps` renders the accumulated result:

```
GAPS  17 distinct  ·  18 observations

  WHAT WOULD FIX THEM
  curate                           15  83% — rows, aliases, measures
  train                             3  17% — model judgement
  of which labelled                 2  the user supplied the answer

UNKNOWN_FOOD  ·  No row in either tier
     2x   2u  kinoa            best guess: Beef, ground, 85% lean, cooked (0.56)
     1x   1u  guacamole        best guess: Avocado, raw (0.69)

UNCURATED_FOOD  ·  Answered only from the USDA corpus
     1x   1u  kimchi           → fdc:170392

CORRECTED_FOOD  ·  The user overruled the food we picked
     1x   1u  ekmek            fdc:174924 → fdc:172688

CORRECTED_AMOUNT  ·  The user moved the amount we estimated
     1x   1u  fdc:170567       28 g → 70 g
```

Ten kinds, each attached to the component that can fix it: a food neither tier could name, one answered only from the uncurated corpus, a tie a model had to break that an alias would settle for free, a measure word we cannot convert, a portion that fell to the ladder's last rung, a dish the extractor split, text a person meant as a meal that read as nothing, a food that was on the plate and never came out at all, and the two kinds of correction.

**The `curate` / `train` split is the part worth arguing with.** Most of what a food logger does not know is a missing row, and no amount of fine-tuning supplies one: a model cannot be taught quinoa's calorie content by gradient descent, because in this architecture the number has to come from a row someone can cite. So the report leads with that ratio rather than a total, and names the two piles separately. The training pile is the smaller one, and it is real — an extractor that splits a dish with its own database row is a model error, not a data gap.

A record is only a *labelled* training example when the user supplied the answer, which is why corrections are counted apart. `npm run gaps -- --labelled --jsonl train.jsonl` exports exactly those; everything else is a candidate that still needs a human to say what the right output was. Saying that plainly matters more than the export format: a file of unlabelled failures presented as a training set is how a fine-tune quietly learns to reproduce them.

- `GET /v1/gaps` — the same data as JSON, `?format=text` for the report, `?format=jsonl` for the export, `?kind=` for one queue.
- `DELETE /v1/me` — erasure, and it reaches this ledger too. See [below](#erasure).
- **Privacy.** This is the one component that deliberately keeps meal text, where the logger redacts it — the words *are* the deliverable. It earns that by keeping as little else as possible: user ids are salted hashes used only to count distinct people, the salt is generated per installation and never leaves the disk, the export never emits the hashes, entries are capped with the eviction count reported, and the directory is git-ignored and outside the repository. `GAPS=off` disables collection entirely. The eval builds its pipeline without a ledger, so a benchmark run never pollutes the record of what real people asked for.

---

## Erasure

Four stores here hold data derived from one person, and only the first is the obvious one:

| store | what it holds | what `DELETE /v1/me` does to it |
|---|---|---|
| meals | the logs themselves | deletes them |
| idempotency cache | a replayable copy of a log, under its key | deletes it — a cached meal *is* the meal, and leaving it would make the deletion a lie |
| alias table | their corrections | deletes the user-scoped rows. The curated global seed is nobody's correction and stays |
| gap ledger | the phrases that defeated the resolver | deletes rows only they hit; removes their pseudonym from rows other people hit too |

The receipt is itemised rather than a bare `204`, because one of those guarantees is deliberately partial and the partial one is the interesting one:

```json
{
  "erased": { "meals": 10, "cachedResponses": 0, "corrections": 2, "gapRows": 10 },
  "retained": { "sharedGapRows": 1, "note": "..." }
}
```

A gap row other people also hit keeps its aggregate and loses only this account's pseudonym, so the distinct-user count drops by one. Deleting it outright would be the stronger promise and it is the wrong one: knowing which of the kept sample spellings was whose means storing that mapping — retaining *more* personal data in order to be able to erase it. The ledger is aggregate by construction, and this keeps it that way.

Two smaller decisions worth naming. The user id must be sent explicitly: everywhere else a missing `x-user-id` falls back to `anonymous`, and here that fallback would let a header-less request wipe the shared anonymous bucket, which is the one destructive accident this API has available. And the ledger goes to disk immediately rather than through its two-second write debounce, because an erasure still sitting in a timer is not an erasure.

What this does **not** do: authenticate. Identity here is a device header and nothing else, so anyone holding a device id can erase that device's data. That is the same "auth is out of scope" position as the rest of the API rather than a hole specific to this route — but erasure is where it stops being merely a demo shortcut, and a real deployment must not ship this route as it stands. The golden and photo eval sets are fixtures in the repository, hand-written and never fed from traffic, so there is nothing of anyone's in them to remove.

---

## Compared to EatBetter

As of 25 August 2026, EatBetter's [App Store listing](https://apps.apple.com/us/app/eatbetter-ai-food-journal/id6639614109) and [official site](https://eatbetterai.com/) lead with instant AI meal photos, barcode scanning, an AI coach, personalised guidance and daily progress. I have not run the app, so I am not going to invent claims about its internals or accuracy. What follows is grounded in the public product promise, documented and reproducible failures of photo-calorie apps in this category, and specific design decisions here that address them. Every row names how to check it.

| | Category norm | mise | How to verify |
|---|---|---|---|
| **The same words, twice** | Re-scanning returns different calorie counts — a recurring complaint in shipped apps' reviews | Rungs 1–4 are pure functions and the model tier runs at temperature 0, so identical *extraction* gives byte-identical nutrition | Log the same text three times. A test asserts it |
| **The same photo, twice** | A single confident figure that quietly changes | It changes here too, and that is a limit rather than a fix — but it changes *inside the range that was shown*. Two consecutive runs of the same JPEG read 736 and 865 kcal, and each figure sits inside the other run's stated interval | Photograph one plate twice in each app. Compare what moved against what each app claimed to know |
| **Precision** | A single figure to the calorie: "537 kcal" | A range, plus a sentence saying the width is the honest part | Log "bir avuç badem" in both. One will give you a number; the other tells you it could be 340–1000 kcal |
| **Where the number came from** | Not exposed | Tap any item: matched row, portion assumption, literal arithmetic, source citation | Ask either app why it said 537 |
| **Being wrong** | Full edit form or a search screen | One question, chosen by how many calories the answer moves, answered by tapping a chip | Log "yogurt" in both and count the taps to fix it |
| **Being corrected** | The correction applies to that entry | The correction becomes a per-user alias: the same phrase resolves instantly and deterministically next time, with no model call | Correct "tavuk" → thigh, log "tavuk" again. A test asserts this |
| **A food the AI missed** | The list is whatever the model produced. A food it never saw has no row to edit, so the repair is to log the meal a second time | Add the missing line to the meal in front of you: search the verified vocabulary, pick a row, set an amount or let the ladder estimate. Same meal, same photograph, same item ids, every earlier correction intact | Photograph a plate with a drink beside it. Count what it takes to get the drink into that same log |
| **Turkish** | Usually a translation layer over an English database | Turkish is a first-class input path: measure words, agglutinative stemming, diacritic folding, Turkish food rows, curated Turkish defaults | Log "çayın yanında 2 küp şeker" |
| **Packaged food** | Barcode scanning is common, and usually presented as exact | Same scan, but the tolerance is stated: a printed serving is a fact, "I ate one serving" is not, so it reads ±8% rather than ±0% | Scan the same item in both and compare what each claims about its own certainty |
| **Published accuracy** | Category-leading apps generally publish none | `npm run eval` — test set, metrics, error taxonomy, and a warning when the benchmark is saturated | Run it |

**How I would measure the improvement in production**, beyond the offline eval: correction rate per logged item and its decay over a user's first 30 days (the alias loop should bend this down, and it is the cleanest evidence that the system learns); time-to-log for repeat meals; abandonment rate on the review screen; and the share of logs auto-accepted without a correction within 24 hours.

That last row is also the cleanest label this system collects. A missed item arrives with its own answer attached — the food was there, here are the words for it, here is the row it should have reached — so it is filed as `missed_item`, which the gap report counts as labelled and the JSONL export ships straight into a fine-tune. An extraction miss is normally the one error class you cannot mine from traffic, because nobody tells you about the thing that is not on the screen.

**The failure cases that show the difference** are the adversarial stratum, and they are all runnable: `X01` (cream vs milk, the documented 380 kcal VLM error), `X05` (raw vs cooked rice, 365 vs 130 kcal/100g), `A06`/`X12` (boiled vs fried potato in both directions), `X10` (butter stated in the text, ~100 kcal, trivially dropped by a naive splitter), `X07`/`X14`/`X17` (non-food, nothing-eaten, and prompt injection, where the correct answer is an empty log).

> **For the submission:** install EatBetter, run those seven inputs through it, screenshot the outputs, and put them side by side with `npm run eval -- --stratum=adversarial`. A small honest sample beats a general claim, and it is exactly what the brief asked for.

---

## Where this is weak

The most important section here.

**The benchmark is saturated and contaminated.** It reads 100%, which almost certainly means it has stopped measuring rather than that the problem is solved:

- I wrote both the food database aliases *and* the test cases. That is contamination. A case that passes because I added the alias it needs proves nothing about a user's phrasing.
- I iterated the rules against these exact cases, which is overfitting by construction.
- 46 cases is small, and the text-only strata are the easy half of the problem.
- With zero failures there is nothing to calibrate against, so the band thresholds **cannot** be fitted on this data. I deliberately did not tune them to make the auto-log rate look better; doing so would be fitting noise. The eval prints this warning itself.

**The photo cases are qualitative, and that is a real limit.** `npm run eval:photos` runs five real meal photographs and reports what can actually be judged from a picture: which foods were named, which were correctly declined, and whether anything was invented. What it deliberately does *not* report is calorie accuracy, because these have no weighed ground truth. A person estimating portions by eye averages ~41% error, which is larger than the quantity a score would be measuring — and I proved the point on my own labels: I wrote down "sweet potato fries" for P5, the model read roasted carrots, and the model was right. A MAPE against labels like mine would have been a number that looked rigorous and meant nothing.

So photo *portion* accuracy remains unmeasured here. Measuring it needs a weighed set — Nutrition5k is the obvious candidate — and that is the first thing I would build with more time, not another model.

**The confidence is measurably wrong in one direction.** ECE is 0.2066 and every populated bin is under-confident: the pipeline is right far more often than it claims, which is why only 43.5% of logs auto-accept. That is a real cost to users, and it is unfixable with the data I have.

**The curated database is 121 rows.** It covers the ambiguity pairs the tests need and common Turkish foods, with aliases and household measures — and it will always be too small. 13,339 USDA rows now sit behind it as a verifier-gated second tier, which is a real coverage answer rather than a hopeful one. If the model verifier is unavailable, those rows remain selectable by the user but never auto-log. A corpus row has no Turkish name, no aliases and no curated household measures, so its portion interval is wider — and a food in neither tier still cannot be logged at all.

Where the remaining holes are is now a measurable question rather than a worry. USDA covers American eating: it has guacamole, sushi, pad thai and baklava, and it has **no chimichurri, no kebab, no shawarma** — and Turkish home cooking is in this build only because I typed those 121 rows myself. A Turkish product would need a Turkish reference table (TürKomp is the obvious candidate) as a fourth set, and that is a data partnership rather than an afternoon. Coverage is a data problem, not an architecture one (`CanonicalFood` is the shape any import produces), and the gap ledger names the exact rows worth writing first, ranked by how many real people hit them.

Running real photographs is what made that concrete rather than theoretical. With the curated tier alone, **P5 logged 0 kcal**: steak under chimichurri with roasted carrots and broccoli, and nothing on that plate had a row. The system behaved correctly — it named nothing it could not cite and asked the user — but "honest and useless" is still useless.

The corpus tier is the answer to that, and it works: the same photograph now logs 735 kcal with a USDA citation on every item, and across the five photos the declined share went from 17 of 23 items to 4 of 21. It is also not a free win, and the costs are all visible in that run. Every corpus match is a second verifier call, so photo latency roughly doubled (14-37 s against 12-16 s). A corpus row has no household measures, so its portion falls to the ladder's last rung more often. And the confidence ceiling means a plate answered from the corpus can never auto-log — correct, but it moves work to the user. The queue that fixes all three is `uncurated_food` in the gap ledger: it names the exact rows worth promoting into the curated seed, ranked by how many real people hit them.

**The verifier trades one kind of error for another, and I have not found the right point on that curve.** It correctly rejects sesame-seeds → tahini and steak → ground beef, which were the failures that motivated building it. It still accepts sweet potato fries → french fries, despite that pair being named in its instructions as an example to reject.

P4 is where that curve is easiest to see, because the same photograph has now produced an error in each direction. Before the corpus tier the verifier declined `"jumbo pasta shells"` → pasta and the pan came out at **66 kcal** — the grated cheese and nothing else. Now it accepts `"spinach and cheese stuffed shells"` → **börek**, a phyllo pastry: the right idea (dough with cheese in it), the wrong dish, and a denser one, so the pan reads 492 kcal. Both answers are defensible one at a time and neither is right, which is the honest summary of where this sits. A verifier tuned by argument rather than by data will keep landing somewhere on that curve at random. Measuring where the line should sit needs the labelled photo set this submission does not have.

**Retrieval can miss a row that is sitting right there, and the verifier will not always catch it.** P5 is the case, and it is the sharpest failure in this repository. The plate is steak under chimichurri. The extractor described the sauce as `"herb and chili sauce"` — a fair description — and the resolver matched it to **Hot pepper sauce**, which is Tabasco, at 12 kcal/100g. `recipe:chimichurri` is in the curated tier at **548 kcal/100g**. So the one component the case was written to probe is under-reported by roughly 165 kcal, and it is marked as a match rather than declined: the system is quietly wrong there, which is the failure mode this whole design exists to prevent.

Two words are lexically close and ten times apart in energy per gram. The verifier rung is exactly the thing meant to catch that, and it did not. What would: the sauce rows are new, and none of them carry the aliases that make the curated tier work — "chimichurri" has no `otlu acı sos`, no `herb sauce`, no `green sauce`. Coverage without aliases is a row nobody can reach.

Run-to-run variance is part of the same picture, and it is larger than I would like. Across two consecutive runs of these five photographs, **P5 read 736 kcal and then 865 kcal** — the second run decided a pale smear beside the steak was potato purée and added 150 g of it, and phrased the broccoli differently. Earlier runs called one item `"fried anchovies"`, then `"anchovies"`, and the carrots `"carrots"` once and `"carrot sticks"` the next time; each of those is the difference between a decline and a match. Resolution is deterministic. What the model chooses to *call* the food is not, and on a five-photo set that noise is larger than most changes I could make to the resolver.

The one thing that behaved well under that variance is the interval: 736 sits inside the second run's stated range and 865 sits inside the first's. A single confident figure would have moved 129 kcal with nothing on screen admitting it could.

That is also why widening the corpus from 7,793 rows to 13,339 barely moved this table: these five plates were already covered. The rows FNDDS added are **dishes** — guacamole, sushi, pad thai — and none of these photographs contain one. The gain is real and it is simply not what a five-photo set measures, which is one more reason the weighed set is the thing this submission most needs.

**Photo latency was 20-65 s per meal, then 12-16 s — except when it was 623 s.** Resolving items concurrently instead of serially did most of the work, since they were never dependent on each other. Then re-running the cases surfaced something the averages had been hiding: one photo spent **623 seconds** in a single provider call while its four neighbours took 12-16. Nothing in the system had a ceiling on an outbound call, and retrying is no defence against a request that never comes back — attempt two hangs exactly as well as attempt one.

Every outbound call now has a per-attempt timeout (30 s extraction, 10 s verification, 8 s barcode), a hang is classified as retryable, and the client carries its own per-route deadline plus a cancel control. That is a bound, not a speed-up — and the corpus tier spent the headroom it bought: photos now run **14-37 s**, because a plate with three unknown foods makes three more verifier calls. Batching the verifier's shortlists into one request instead of one call per unresolved item is the real remaining win, it would pay for the corpus rung outright, and it is not done.

**A line can be added and corrected, but not removed, and I now have a case that wants it.** The mirror of the missing-item problem is the invented one: a plate read as five items when there were four. The harness scores 0 invented, but that counter is judged against what I labelled, and the second P5 run added `potato puree` at 150 g — about 130 kcal — for a pale smear beside the steak. It is arguable rather than clear-cut, which is exactly why it matters: a human would want to swipe that line away, and there is no way to. It is a small route (`DELETE /v1/meals/:id/items/:itemId` over the same `rebuild`) and it should have been built before the add. What held it back is that I want it to record a `phantom_item` gap, and I would rather settle that taxonomy against real traffic than invent it — but that is a reason to ship the route and defer the gap kind, not to ship neither.

**Deliberately out of scope**, and named rather than hidden: authentication beyond a device header, persistence beyond in-memory stores, offline sync, and daily targets or charts. The brief's focus was accuracy; these would have taken time away from it.

---

## The questions you said you'd ask

**Biggest trade-off?**
Constrained, retrieval-based resolution instead of letting a model answer freely. The cost is real: coverage on long-tail and regional foods is bounded by the database, and a food that is not in it cannot be logged no matter how well the model recognises it. What I bought is that nutrition is always traceable to a citable row, the system is deterministic, and accuracy work has somewhere specific to happen. I would make the same call again for a health-adjacent product, where a confidently wrong number is worse than an honest "I don't know that food".

The second trade-off is one I am less comfortable with: I spent the time on measurement infrastructure rather than on breadth. A demo with 500 foods and photo support would look better. This one can tell you when it is wrong, which I think is the thing that actually compounds — but it does mean the app looks thinner than it could.

**Top 3 for accuracy next?**

1. **Route the portion question to the cheapest method that can answer it.**

   I started by assuming the answer was a better vision model. The literature says otherwise, and so does my own measurement, so here is the whole option space with the numbers attached:

   | how the portion is obtained | calorie error | cost to the user | available |
   |---|---|---|---|
   | barcode on a packaged item | label accuracy, ~0% | one scan | now — >90% barcode coverage commercially |
   | a repeat of a meal this user already confirmed | ~0% | one tap | now — this is just the alias loop, extended to mass |
   | published menu for a chain restaurant | label accuracy | pick from a list | now — 35M+ indexed menu items |
   | photo **with a reference object in frame** | **18%** | put a card next to the plate | **now, no hardware** |
   | photo + phone LiDAR depth fusion | 15–20% (8.3% volume error) | hold the phone still | Pro-tier phones only |
   | photo + depth as a model input | 16.5–18.8% | — | needs a depth sensor |
   | photo alone, software only | 23–35% | nothing | now |
   | a trained dietitian, by eye | 41% | — | — |

   Two numbers reframe the whole problem. Nutrition5k's model predicting **calories per gram** scores 9.5% error; the *same model* predicting **total calories** scores 26.1%. Identification is close to solved and portioning is nearly three times harder — which is exactly the split I measured on my own vision path, where four runs of one photo returned identical foods and a portion that swung 84%.

   And a plain credit card in frame takes a 2D photo from 34% to 18%, which is within reach of LiDAR at zero hardware cost. That is the best accuracy-per-effort intervention in the table, and almost nobody asks for it.

   So the answer was not a bigger model, it was a **ladder with the same shape as the resolver**. That is now built and shipped — [the portion ladder](#the-portion-ladder) — with the barcode, user-memory, reference-object and household-measure rungs live, and each one surfaced in the app with its own tolerance so the user can see which action would buy a tighter number.

   What is **not** built, in the order I would add it:

   ```
   chain restaurant menus  → published nutrition   label accuracy   (data deal)
   phone LiDAR depth       → volume from depth     ~15-20%          (Pro-tier only)
   promptable segmentation → counts and areas      feeds rung 5     (SAM 3)
   ```

   **Where segmentation fits.** SAM 3 is a component of the reference-scaled rung, not a replacement for the VLM. Its promptable concept segmentation takes a noun phrase and returns every instance of it, which turns "how many olives" from a guess into a count, and gives the pixel area a reference object converts into real area. Its presence head — deciding whether a concept is there at all before localising it — is a second, independent opinion on existence, which makes a phantom item (E3) detectable rather than merely unlikely. It is callable today through Roboflow's hosted inference or locally through the same package. Valuable, but it earns its place behind barcode, repeat memory and the reference object, all of which are cheaper and more accurate.

   **Two refinements worth taking early.** Sampling the VLM several times and using the *spread* as the interval converts the instability I measured from a defect into a calibrated uncertainty estimate — self-ensembling VLMs report up to 23% relative accuracy gains and uncertainty that tracks error. And before-and-after photos are the only published way to catch plate waste, which every photo-only app silently counts as eaten.

   None of the remaining rungs can be tuned without the other half of this item: **a photo test set with weighed ground truth.** The five photo cases here can prove the system does not invent food; they cannot prove a portion method is better than the one it replaced. Until there is a weighed set, every row in that table is a hypothesis with a citation attached.

2. **A held-out set written by someone who has not seen the food database.** The current one cannot distinguish a better pipeline from a worse one. This is cheap and it unblocks calibration, which unblocks the auto-log rate.
3. **Promote user corrections into global aliases** once enough distinct users correct a phrase the same way. The mechanism is already there (`promotionCandidates`); it is deliberately not automatic, because one person's habit is not a fact about the world and letting it become one is how a shared food database quietly poisons itself.

**What breaks at scale?**

Cost per log is the first wall: at rung 5 pricing, the escalation rate is the whole economic model, which is why the deterministic share is a headline metric rather than a footnote. Then the traffic shape — three sharp spikes a day, synchronised across the user base, so capacity is sized for the peak and retry storms are the realistic outage. Then the alias tables, which grow per user and are read on the hot path. Then the eval set going stale as the food database grows, since coverage is a moving target. The in-memory stores obviously go first, but that is a known missing piece rather than a scaling surprise.

**Biggest security/privacy risks?**

Meal photos are health data, and they are special-category under GDPR and KVKK. They routinely contain faces, homes, medication on the table, and location signal in EXIF. Concretely: (1) **third-party model providers** — raw images must not go to a provider without a zero-retention agreement, and that is a contract question before it is an engineering one; (2) **logs and traces**, the easiest accidental leak, which is why redaction is in the logger rather than at each call site; (3) **prompt injection via photographed text**, since a menu or label in frame reaches the model as instructions unless the prompt and the rule tier treat it as data, which is what golden case `X17` tests; (4) **right to erasure**, which has to reach the alias tables and the gap ledger and not just the meals table — an alias derived from someone's correction is derived personal data, and so is the phrase that defeated the resolver. `DELETE /v1/me` now reaches all four stores and returns an itemised receipt, including the one guarantee it can only make partially; [Erasure](#erasure) is the whole argument. What it still does not do is authenticate, because nothing in this build does; (5) **cross-user alias leakage**, which is why corrections are user-scoped and there is a test asserting one user's correction does not reach another.

---

## Tools I used

Claude Code (Opus 5) for the whole build: scaffolding, implementation, tests, and this document. I directed the architecture — the router ladder, the closed-candidate constraint, the portion interval, deriving expected calories from the database rather than typing them — and reviewed every file.

Two things worth flagging honestly. First, my initial model recommendation was biased: I asked Claude which model to use and it invoked Anthropic's own tooling, which instructs it to default to Claude. Being pointed at the vendor bias is what produced the adapter interface and the bake-off command, which is a better answer than either single choice. Second, model IDs and prices in the adapters are configurable defaults, not verified quotes; check them against current provider docs before trusting the cost metric.

Web search for the literature cited throughout: Nutrition5k (portion error), the JFB benchmark (general vs food-tuned VLMs), the six-app DAI validation, and the VLM food-recognition comparison. One number I found and deliberately did not use: a ±0.9% MAPE figure attributed to one commercial app. It is not credible — a camera cannot see cooking oil, and dietitians average 41% error — and the sourcing is thin. The category is full of unverifiable accuracy claims, which is most of why publishing a reproducible eval is a differentiator at all.

---

## Layout

```
data/
  foods/seed.json           121 canonical foods, USDA FDC + Turkish reference
  foods/fdc-corpus.json     13,339 USDA rows (SR Legacy + FNDDS + Foundation)
  golden/cases.json         46 labelled cases, three strata
  golden/photos.json        5 photo cases + the invisible calories in each
  golden/photos/            the photographs themselves
packages/api/src/
  domain/                   types, Zod schemas, error taxonomy
  data/
    foodDb.ts               the canonical rows, loaded and integrity-checked
    corpus.ts               the second tier, and why it needs the verifier
    openFoodFacts.ts        barcode lookup — the one untrusted external input
  pipeline/
    normalize.ts            folding, stemming, units, quantities
    extract/                prompt (shared) + rules | gemini | openai | anthropic
      compound.ts           rejoins a dish the extractor took apart
    resolve/                router, lexical, vector, alias store, reranker
    portion/                the ladder: seven strategies, each able to decline
    questions.ts            what to ask, and what is not worth asking
    correct.ts              edits to the meal in front of them: fix a line, add a missing one
    nutrition.ts            arithmetic + the E11 traceability assertion
    confidence.ts           per-stage scoring, banding, disposition
  eval/                     harness, taxonomy classifier, report, CLI, photos
  gaps/                     what mise did not know: ledger, report, CLI
  http/                     Fastify server, idempotency, erasure
  obs/                      logger, metrics
packages/mobile/src/
  screens/                  Log, Scan, Result, History
  components/               the gauge, the amount editor, the question card
  theme.ts                  tokens, contrast ratios recorded
```
