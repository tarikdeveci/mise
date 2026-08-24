# mise

Meal logging that turns messy input into canonical foods, portions and nutrition, and is honest about how sure it is.

Built for the EatBetter Full Stack case study. Node.js / TypeScript backend, Expo (React Native) app.

---

## The one-paragraph version

Every calorie figure this system displays is `per100g × grams ÷ 100` over a row in a food database. No model ever writes a nutrition number, and no model ever names a food ID: the extractor describes what it sees in words, and a resolver maps those words to a canonical row by a ladder of increasingly expensive strategies, stopping at the first one that answers decisively. 96.5% of resolutions on the test set never touch a model at all. What the model *is* used for is the part that genuinely needs judgement, and even there it chooses from a closed candidate list rather than generating an identifier. The result is a system where hallucinated nutrition is not rare, it is structurally impossible, and where the same photo scanned twice cannot produce two different answers.

The second commitment is the portion interval. Nutrition5k measured trained dietitians at ~41% average error estimating portions from images, so a single-figure calorie count is precision the evidence does not support. mise carries min/likely/max through the whole pipeline and shows the range in the UI. On the current test set the true total falls inside the displayed range 100% of the time.

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

Start the app (Expo Go on a phone, or press `w` for the browser):

```bash
npm run mobile
```

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

`npm run eval` on 46 labelled cases, rule extractor, vector retrieval on:

| | |
|---|---|
| exact pass rate (no taxonomy error of any kind) | 100% |
| food match accuracy (correct canonical id) | 100% |
| kcal median APE | 0% |
| kcal within ±10% | 93% |
| **interval coverage** (truth inside the range shown) | **100%** |
| **hallucination rate** | **0%** |
| deterministic resolutions (no model call) | 96.5% |
| auto-logged (needed no user input) | 39.1% |
| precision when auto-logged | 100% |
| calibration error (ECE) | 0.209 |
| latency p50 / p95 | 0 ms / 2 ms |

**Read that 100% as a warning, not a result.** See [Where this is weak](#where-this-is-weak) before believing any of it. The eval tool prints the same warning itself.

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
   ├─ 5  portion        returns an INTERVAL, width set by how the number was got
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
| 5. LLM rerank | ~800 ms | genuinely contested — a model earns its cost here |
| 6. unresolved | — | ask the user one targeted question |

The escalation signal is the **margin** between the top two candidates, not the top score. A 0.9 top score with a 0.02 gap means two foods look equally likely, which is exactly when a model is worth paying for and when the user is worth interrupting.

Two properties fall out of this that matter more than the latency saving:

- **Determinism.** Rungs 1–4 are pure functions, and the model tier runs at `temperature: 0`. Re-scanning the same meal cannot return a different number. This is a documented, reproducible failure of shipped competitors and it is simply not a failure we need to have.
- **Bounded hallucination.** Rung 5 receives a *closed* candidate list. The reranker's schema constrains it to an ID from that list or an abstention; a reply outside the set is dropped and the item falls through to asking the user. It is not "the model usually behaves", it is "the model has no other move available".

---

## The AI/LLM work: hybrid (rules + retrieval + LLM)

I picked the hybrid path, and the reason is measurement rather than taste: it is the only one of the three offered paths where accuracy improvements can be attributed to a specific component and verified.

### What the model is allowed to do

The extraction prompt (`src/pipeline/extract/prompt.ts`, versioned `extract-2026-08-24.a`) withholds three capabilities on purpose, and the response schema enforces each:

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

**Not yet measured.** I have not run the provider bake-off — it needs API keys I did not want to bake into a submission, and more importantly it needs a photo test set that does not exist yet. The harness is built and the command works; the table is empty because running it on a text-only, saturated set would produce a number that means nothing.

### Embeddings

Local `multilingual-e5-small` via `@huggingface/transformers`, not a hosted embedding API. Three reasons: eval runs stay deterministic and free (a benchmark whose numbers drift because a remote model was updated is not a benchmark); Turkish food terms like "kaşar" have no English cognate and lexical matching alone cannot bridge them; and there is no key to manage. If the model cannot load, the layer disables itself and the router degrades to lexical-only rather than the endpoint dying.

**No vector database.** At ~350 surface forms, brute-force cosine is 300 KB and sub-millisecond. An index here is pure overhead. I would revisit at roughly 100k rows or when the food database becomes multi-tenant.

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

Four real bugs, all of which would have shipped silently:

1. **`"180g"` parsed as one token.** The unit was invisible, so the quantity multiplied a household measure: 180 × 120 g = 21.6 kg of chicken, reported as 35,640 kcal.
2. **`\b` is ASCII-only in JavaScript.** `\büzerine\b` never matched real Turkish text, so "ekmek üzerine tereyağı" stayed one fragment and the butter was silently dropped.
3. **The Turkish hedge `"az"` matched inside `"bey-az"`.** Substring matching turned "2 dilim beyaz ekmek" into an unquantified amount and halved it to one slice. This one was caught by the HTTP integration test, not the eval — the golden set happened not to contain a quantified "beyaz ekmek", which is a good argument for having both.
4. **A Fastify 400 was reported as a 500.** Clients were told the server was broken and to retry, when the request was what needed fixing — and real incidents were hidden in the same bucket.

Turkish is agglutinative, so "çay", "çayın", "çaydan" are one food to a person and three strings to a matcher. A light stemmer (one suffix maximum, never below a 3-letter stem) fixed a class of silent misses. Over-stemming would collapse genuinely different foods, which is worse than missing an inflection, hence the conservatism.

---

## Reliability

- **Idempotency.** `POST /v1/meals` accepts an `Idempotency-Key` and stores a hash of the body with it. Replays return the original log; the same key with a *different* body returns 409 rather than silently serving a stale result, because that is a client bug and hiding it helps nobody. Phones lose connectivity mid-request and users tap Save twice; without this, "the network dropped" and "the meal was logged twice" are the same observable event.
- **Retries with full jitter**, both client and server side. Jitter is not a detail here: meal traffic is extremely peaky, three sharp spikes a day at the same clock times for everyone, so a synchronised retry storm is the realistic failure mode. The client retries transport failures only — a 400 will not become a 201 on the third attempt.
- **Graceful degradation.** If the embedding model cannot load, the router runs lexical-only. If a provider is down, the endpoint can fall back to the rule tier: text logging keeps working and the user sees "worth a look" instead of an error.
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

## Compared to EatBetter

I have not used EatBetter's app, so I am not going to invent claims about its internals. What follows is grounded in two things I can defend: documented, reproducible failures of shipped photo-calorie apps in this category, and specific design decisions here that address them. Every row names how to check it.

| | Category norm | mise | How to verify |
|---|---|---|---|
| **Same meal, twice** | Re-scanning the same photo returns different calorie counts — a recurring complaint in shipped apps' reviews | Rungs 1–4 are pure functions and the model tier runs at temperature 0. Identical input returns byte-identical nutrition | Scan one meal three times in each app. A test asserts this for mise |
| **Precision** | A single figure to the calorie: "537 kcal" | A range, plus a sentence saying the width is the honest part | Log "bir avuç badem" in both. One will give you a number; the other tells you it could be 340–1000 kcal |
| **Where the number came from** | Not exposed | Tap any item: matched row, portion assumption, literal arithmetic, source citation | Ask either app why it said 537 |
| **Being wrong** | Full edit form or a search screen | One question, chosen by how many calories the answer moves, answered by tapping a chip | Log "yogurt" in both and count the taps to fix it |
| **Being corrected** | The correction applies to that entry | The correction becomes a per-user alias: the same phrase resolves instantly and deterministically next time, with no model call | Correct "tavuk" → thigh, log "tavuk" again. A test asserts this |
| **Turkish** | Usually a translation layer over an English database | Turkish is a first-class input path: measure words, agglutinative stemming, diacritic folding, Turkish food rows, curated Turkish defaults | Log "çayın yanında 2 küp şeker" |
| **Published accuracy** | Category-leading apps generally publish none | `npm run eval` — test set, metrics, error taxonomy, and a warning when the benchmark is saturated | Run it |

**How I would measure the improvement in production**, beyond the offline eval: correction rate per logged item and its decay over a user's first 30 days (the alias loop should bend this down, and it is the cleanest evidence that the system learns); time-to-log for repeat meals; abandonment rate on the review screen; and the share of logs auto-accepted without a correction within 24 hours.

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

**There is no photo evaluation at all.** This is the biggest gap. The hard modality — portion estimation from an image — has no measurement here. The vision adapters are written and the schema is enforced, but every number above comes from text. Any claim I make about photo accuracy would be unsupported.

**The confidence is measurably wrong in one direction.** ECE is 0.209 and every populated bin is under-confident: the pipeline is right far more often than it claims, which is why only 39% of logs auto-accept. That is a real cost to users, and it is unfixable with the data I have.

**The food database is 68 curated rows**, not the full FDC. It covers the ambiguity pairs the tests need and common Turkish foods. Real coverage is a data problem, not an architecture one — `CanonicalFood` is the shape an FDC import would produce — but 68 rows is a demo, not a product.

**Deliberately out of scope**, and named rather than hidden: authentication beyond a device header, persistence beyond in-memory stores, barcode scanning, offline sync, and daily targets or charts. The brief's focus was accuracy; these would have taken time away from it.

---

## The questions you said you'd ask

**Biggest trade-off?**
Constrained, retrieval-based resolution instead of letting a model answer freely. The cost is real: coverage on long-tail and regional foods is bounded by the database, and a food that is not in it cannot be logged no matter how well the model recognises it. What I bought is that nutrition is always traceable to a citable row, the system is deterministic, and accuracy work has somewhere specific to happen. I would make the same call again for a health-adjacent product, where a confidently wrong number is worse than an honest "I don't know that food".

The second trade-off is one I am less comfortable with: I spent the time on measurement infrastructure rather than on breadth. A demo with 500 foods and photo support would look better. This one can tell you when it is wrong, which I think is the thing that actually compounds — but it does mean the app looks thinner than it could.

**Top 3 for accuracy next?**

1. **A photo test set with weighed ground truth, and portion estimation to go with it.** Portion error dominates calorie error and it is entirely unmeasured here. Depth data is the documented lever — phones have the sensors — and everything else is guesswork until there is a number.
2. **A held-out set written by someone who has not seen the food database.** The current one cannot distinguish a better pipeline from a worse one. This is cheap and it unblocks calibration, which unblocks the auto-log rate.
3. **Promote user corrections into global aliases** once enough distinct users correct a phrase the same way. The mechanism is already there (`promotionCandidates`); it is deliberately not automatic, because one person's habit is not a fact about the world and letting it become one is how a shared food database quietly poisons itself.

**What breaks at scale?**

Cost per log is the first wall: at rung 5 pricing, the escalation rate is the whole economic model, which is why the deterministic share is a headline metric rather than a footnote. Then the traffic shape — three sharp spikes a day, synchronised across the user base, so capacity is sized for the peak and retry storms are the realistic outage. Then the alias tables, which grow per user and are read on the hot path. Then the eval set going stale as the food database grows, since coverage is a moving target. The in-memory stores obviously go first, but that is a known missing piece rather than a scaling surprise.

**Biggest security/privacy risks?**

Meal photos are health data, and they are special-category under GDPR and KVKK. They routinely contain faces, homes, medication on the table, and location signal in EXIF. Concretely: (1) **third-party model providers** — raw images must not go to a provider without a zero-retention agreement, and that is a contract question before it is an engineering one; (2) **logs and traces**, the easiest accidental leak, which is why redaction is in the logger rather than at each call site; (3) **prompt injection via photographed text**, since a menu or label in frame reaches the model as instructions unless the prompt and the rule tier treat it as data, which is what golden case `X17` tests; (4) **right to erasure**, which has to reach the eval sets and the alias tables, not just the meals table — an alias derived from someone's correction is derived personal data; (5) **cross-user alias leakage**, which is why corrections are user-scoped and there is a test asserting one user's correction does not reach another.

---

## Tools I used

Claude Code (Opus 5) for the whole build: scaffolding, implementation, tests, and this document. I directed the architecture — the router ladder, the closed-candidate constraint, the portion interval, deriving expected calories from the database rather than typing them — and reviewed every file.

Two things worth flagging honestly. First, my initial model recommendation was biased: I asked Claude which model to use and it invoked Anthropic's own tooling, which instructs it to default to Claude. Being pointed at the vendor bias is what produced the adapter interface and the bake-off command, which is a better answer than either single choice. Second, model IDs and prices in the adapters are configurable defaults, not verified quotes; check them against current provider docs before trusting the cost metric.

Web search for the literature cited throughout: Nutrition5k (portion error), the JFB benchmark (general vs food-tuned VLMs), the six-app DAI validation, and the VLM food-recognition comparison. One number I found and deliberately did not use: a ±0.9% MAPE figure attributed to one commercial app. It is not credible — a camera cannot see cooking oil, and dietitians average 41% error — and the sourcing is thin. The category is full of unverifiable accuracy claims, which is most of why publishing a reproducible eval is a differentiator at all.

---

## Layout

```
data/
  foods/seed.json           68 canonical foods, USDA FDC + Turkish reference
  golden/cases.json         46 labelled cases, three strata
packages/api/src/
  domain/                   types, Zod schemas, error taxonomy
  pipeline/
    normalize.ts            folding, stemming, units, quantities
    extract/                prompt (shared) + rules | gemini | openai | anthropic
    resolve/                router, lexical, vector, alias store
    portion.ts              interval estimation
    nutrition.ts            arithmetic + the E11 traceability assertion
    confidence.ts           per-stage scoring, banding, disposition
  eval/                     harness, taxonomy classifier, report, CLI
  http/                     Fastify server, idempotency
  obs/                      logger, metrics
packages/mobile/src/
  screens/                  Log, Result, History
  components/               RangeBar and the rest
  theme.ts                  tokens, contrast ratios recorded
```
