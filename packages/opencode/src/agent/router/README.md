# Auto-Router

Automatic routing between **single-agent** and **coordinator (multi-agent)** mode for opencode.

The router analyzes each user prompt and the workspace, then decides whether to run the task on a single agent (default) or escalate it to the coordinator, which spawns multiple parallel workers. Users never have to manually pick coordinator mode — it just happens when the task warrants it.

Works across **CLI**, **TUI**, and **Desktop** frontends.

---

## Reader's guide

This is a long document. Jump to the section you need:

| You are… | Go to |
|---|---|
| An end user trying it out | **[Quick start](#quick-start)** |
| Building a mental model of how it decides | **[How a decision is made](#how-a-decision-is-made)** — walkthroughs with real numbers |
| Debugging a specific routing decision | **[Inspecting a decision](#inspecting-a-decision-opencode-debug-router)** |
| Extending or tuning the router | **[For contributors](#for-contributors)** |
| Reading the full architectural spec | [`docs/superpowers/specs/2026-04-23-opencode-auto-router-design.md`](../../../../../docs/superpowers/specs/2026-04-23-opencode-auto-router-design.md) |
| Reviewing what has been validated | [`docs/superpowers/plans/2026-04-24-auto-router-test-results.md`](../../../../../docs/superpowers/plans/2026-04-24-auto-router-test-results.md) |

---

## Quick start

### For end users

**TUI / Desktop:** Out of the box, the top of the agent picker is a new **"auto"** option — selecting it (the default for new sessions) enables automatic routing. Pick any specific agent to bypass routing and force that agent.

**CLI:** Pass `--agent auto` (or just omit `--agent`) to enable routing. Pass `--agent coordinator` to force coordinator mode, or `--agent <other>` to force a specific agent.

When routing kicks in, you'll see a one-line announcement before the agent starts:
```
→ Routing: coordinator · 5 packages, 200 files
→ Routing: single · single-package edit
→ Routing: coordinator · inherited from previous turn
```

Explicitly passing `--agent <name>` bypasses the router entirely — no announce line fires, the chosen agent just runs.

### To disable the LLM tiebreaker

Edit `packages/opencode/src/agent/router/weights.json`:
```json
{ "tiebreaker": { "enabled": false } }
```

This makes the router 100% heuristic — no additional LLM calls, at the cost of slightly lower recall on ambiguous prompts (they default to single-agent).

---

## How a decision is made

The router's job is simple to state but careful in practice: **pick the cheapest mode that will actually do the work**. Single-agent is faster and cheaper; coordinator parallelizes across workers but has coordination overhead. The wrong choice either wastes tokens (coordinator on a typo fix) or drops work on the floor (single-agent on a repo-wide refactor).

### Mental model

Every decision is shaped by **two independent dimensions**:

- **Is the task ambitious?** (prompt side) — are you asking to do one thing or many? Does the scope touch one module or many packages?
- **Does the workspace support parallelism?** (codebase side) — is this a single-package lib or a 20-package monorepo?

These are combined with an **AND-gate**: `primaryScore = min(promptScore, codebaseScore)`. Coordinator fires only when *both* are high. A complex prompt on a tiny repo → single. A trivial prompt on a massive monorepo → single. No coordinator without both an ambitious ask *and* a workspace where parallelism helps.

### The six steps

```
User prompt arrives
    │
    ├─ (1) Override?
    │     --agent foo, or picker set to a specific agent → use that, skip router
    │
    ├─ (2) Inheritance?
    │     turn 2+, previous decision exists, no escape → reuse, skip router
    │
    └─ (3) Full routing
          a. Analyze workspace — file count, packages, manifest names, languages
          b. Extract 6 prompt signals (P1…P6)
          c. Extract 5 codebase signals (C1…C5)
          d. Weight + normalize → two scores (prompt, codebase)
          e. Apply AND-gate + decision bands → mode + confidence
          f. If "uncertain" band → LLM tiebreaker decides
```

Each step has an exit. Most turns skip full routing entirely — either because the user forced an agent (override) or because turn 2+ inherits the prior decision.

### Walkthrough — three worked examples

All three are run against the opencode monorepo itself (15+ packages, ~4500 files). Reproducible with `opencode debug router --json "<prompt>"`.

**Example 1: a trivial prompt, even on a huge monorepo**

> *"fix the typo on line 42"*

| | |
|---|---|
| Fired signals | C1 (many files), C2 (many packages) — **no prompt signals fire** |
| promptScore | 0.00 |
| codebaseScore | 3.33 (opencode is objectively a big repo) |
| **primaryScore** | **0.00** (AND-gate takes the min) |
| Band / decision | strong-single → **`single, high confidence`** |

Even though the codebase side is screaming "this is a huge monorepo", the prompt is a single-line typo fix. The AND-gate caps the primary at whichever side is lower. Coordinator never fires on trivial prompts, no matter how big the repo is.

**Example 2: ambitious-sounding but not specific**

> *"refactor the entire auth system"*

| | |
|---|---|
| Fired signals | P3 (scope keyword "entire" + mutation verb "refactor"), C1, C2 |
| promptScore | 1.21 |
| codebaseScore | 3.33 |
| **primaryScore** | **1.21** |
| Band / decision | **uncertain → LLM tiebreaker fires** |

The heuristic is unsure. "Entire auth system" sounds broad, but there's no named package, no glob, no explicit file path. A single-LLM call (`generateText`, 3-second timeout, small model) reads the prompt + fired signals and returns single/coordinator in one shot. If the tiebreaker fails for any reason — timeout, malformed output, rate-limited — the router falls back to `single, low confidence` rather than blocking the turn.

**Example 3: unambiguous multi-package work**

> *"refactor all auth handlers across @opencode-ai/app and @opencode-ai/sdk. update every caller throughout the codebase"*

| | |
|---|---|
| Fired signals | P2 (two scoped packages), P3 (three scope keywords with mutation verbs), P4 (conjunction chain), C1, C2, C3, C4 |
| promptScore | 5.15 |
| codebaseScore | 8.33 |
| **primaryScore** | **5.15** (min-gate; prompt is the narrower constraint here) |
| Band / decision | strong-coordinator → **`coordinator, high confidence`** |

No tiebreaker invoked — the heuristic is confident. The coordinator receives hints (`suggestedWorkerCount`, `suggestedPartition` aligned to the named packages) so its first action is informed by the routing signal rather than rediscovering the partition from scratch.

### Why this shape of design

- **Two-dimensional composite, not a single scalar.** A single score conflates "ambitious prompt" with "big repo". The AND-gate prevents both failure modes: escalating trivial prompts on large repos, and dropping ambitious prompts on small repos.
- **Five decision bands, not a binary threshold.** Bands carry confidence. Strong-coordinator fires with no second opinion; uncertain band always consults the LLM. This matches how the cost of each mistake differs by confidence level.
- **Heuristic first, LLM only in the uncertain band.** ~80% of turns decide on heuristics alone (<10ms warm). The LLM runs on the ~20% where heuristics are genuinely unsure — bounded by a per-session rate limit, circuit breaker, and 3-second timeout, so bad-network days can't stall every turn.
- **Inheritance keeps multi-turn sessions stable.** Turn 1 decides; turns 2+ reuse unless something substantive changed (workspace, archetype, user said `/reroute`). Avoids the "every turn re-thinks from scratch" cost.

---

## How it works (compressed reference)

### Data flow

```
                        ┌───────────────────────────────┐
  user prompt ────────► │        scorer.ts              │
                        │   P1-P6 extractors            │◄───  weights.json
  workspace root ──► ┌──┤   C1-C5 extractors            │      (signal weights,
                     │  │   classifyArchetype()         │       decision bands,
                     │  │                               │       mutation verbs,
                     │  │   → primaryScore =            │       scope keywords,
                     │  │     min(promptScore,          │       tiebreaker config)
                     │  │         codebaseScore)        │
                     │  │   → band lookup               │
                     │  └────────┬──────────────────────┘
                     │           │
                     │           ▼
                     │    band in [1.0, 2.0)?  ──yes──►  classifier-real.ts
                     │           │ no                       (small LLM, ≤3s timeout,
                     │           ▼                           wrapped by circuit breaker
                     │   RoutingDecision                     + rate limit in classifier.ts)
                     │   { mode, confidence, reason,                  │
                     │     firedSignals, fingerprint }                │
                     │           │◄───────────────────────────────────┘
                     │           ▼
                     │   integration.ts → selectAgentMode()
                     │           │
                     │   (check override → inheritance → route)
                     │           │
                     │           ▼
                     │   agentName: "default" or "coordinator"
                     │   announceText: "→ Routing: …"
                     │   hints (if coordinator)
                     │
workspace-analyzer.ts │  — file count, package names
  (called by scorer)  │  — language detection
  (called by router)  │  — pyproject.toml + package.json
                     ▼
             fingerprint.ts
             (hash of manifests + top-dirs — used for inheritance drift check)
```

### Path through the pipeline

```
User prompt arrives
    │
    ├─ Override? (--agent foo, or TUI/Desktop picker set to a specific agent)
    │     → Use that agent, skip router
    │
    ├─ Inheritance? (turn 2+, previous decision exists, no escape condition)
    │     → Reuse previous decision, skip router
    │
    └─ Full routing
          1. Analyze workspace (file count, packages, languages)
          2. Extract prompt signals (P1–P6)
          3. Extract codebase signals (C1–C5)
          4. Normalize → weight → composite score
          5. Apply decision bands + floor rules
          6. Uncertain band? → Fire LLM tiebreaker
          7. Return: single or coordinator
```

### Signal taxonomy

**Prompt signals** (what the user is asking):

| Signal | Detects |
|---|---|
| P1 Glob mentions | `**/*.ts`, `src/**`, `*.{ts,tsx}` patterns |
| P2 Package mentions | Specific `@org/pkg` names from the workspace |
| P3 Scope keywords | "all", "every", "across" — only with a mutation verb |
| P4 Conjunction chains | Multiple mutation verbs joined by "and" |
| P5 Explicit paths | File/directory paths with extensions or project prefixes |
| P6 Task archetype | Classifies as read-only / trivial / mutating-narrow / mutating-broad |

**Codebase signals** (what the workspace looks like):

| Signal | Measures |
|---|---|
| C1 Total files | Source file count (excluding node_modules, .git, dist) |
| C2 Package count | Top-level manifests (package.json, Cargo.toml, etc.) |
| C3 Affected subset | Files in packages the user mentioned |
| C4 Cross-package | Does the prompt touch ≥2 distinct packages? |
| C5 Multi-language | More than one language in the workspace? |

### Decision composite

```
primaryScore = min(promptScore, codebaseScore)    // AND-gate
```

Coordinator requires **both** an ambitious prompt AND a workspace that supports parallelism. Complex prompt on a tiny repo → single. Trivial prompt on a massive monorepo → single.

### Decision bands

| Band | Primary score | Action |
|---|---|---|
| Strong single | [0, 0.5) | single, high confidence |
| Lean single | [0.5, 1.0) | single, medium confidence |
| **Uncertain** | [1.0, 2.0) | **Fire LLM tiebreaker** |
| Lean coordinator | [2.0, 3.0) | coordinator, medium confidence |
| Strong coordinator | [3.0, 10] | coordinator, high confidence |

### LLM tiebreaker

When the heuristic score lands in the uncertain band (~20% of turns), the router consults a cheap LLM for a second opinion:

- Uses opencode's **small_model** setting (Claude Haiku, GPT-5 Nano, Gemini Flash, local Ollama — whatever's configured)
- Single `generateText` call with 150-token budget, 3-second timeout
- One-shot classification — not a conversation
- **Safeguards**: rate limit (20/session), circuit breaker (5 failures → 60s disable), conservative-low-confidence mapping
- **Cost**: ~$0.0001/call on Haiku, fractions of a cent on Nano, free on local models
- **Can be disabled** via `tiebreaker.enabled: false`

---

## Inheritance (multi-turn sessions)

After turn 1, subsequent turns **inherit** the previous decision unless an escape condition fires:

| Priority | Escape | Example |
|---|---|---|
| 1 | `/reroute` prefix | User wants fresh routing |
| 2 | Workspace fingerprint changed | New package added, directory renamed |
| 3 | Session stale (>30 min) | User resumed after a break |
| 4 | Short trivial follow-up | "thanks", "ok", "yes" |
| 5a | Archetype flip: coordinator → read-only | "explain what you just did" |
| 5b | Archetype flip: single → mutating-broad | "refactor all auth across packages" |

---

## Inspecting a decision (`opencode debug router`)

Run the router on a prompt without actually executing an agent. Useful for tuning weights, understanding a specific routing decision, or debugging fallback behavior.

```bash
# Pretty-printed
opencode debug router "refactor all auth across @app/auth and @app/api"

# JSON output (for scripting)
opencode debug router --json "..." | jq '.decision, .scores, .firedSignals'

# Actually invoke the tiebreaker (costs 1 small-model call)
opencode debug router --full "..."

# Against a different workspace
opencode debug router --dir /path/to/repo "..."
```

The output shows every signal value, the primary/secondary scores, fired signals, decision + confidence, and whether the tiebreaker would fire or actually ran. If the heuristic decision disagrees with your intuition, this tells you exactly which signals fired (or didn't).

---

## Safety nets

- **Router never throws** — any error falls back to single-agent, user's turn always proceeds
- **Error budget banner** — if 4 of 20 recent turns hit fallback, a warning appears
- **Circuit breaker** — LLM tiebreaker disabled for 60s after 5 consecutive failures, with half-open recovery
- **Rate limiter** — max 20 tiebreaker calls per session
- **Conservative default** — every ambiguity resolves to single-agent

### Fault injection (ops debugging)

For verifying fallback paths in a live environment — not for production use. Gated behind two environment variables so it can never activate accidentally:

```bash
# Force the analyzer to throw on every call
OPENCODE_ROUTER_DEBUG=1 OPENCODE_ROUTER_FAULT_INJECT=analyzer-fail opencode ...

# Force the LLM tiebreaker to fail with a timeout-shaped error
OPENCODE_ROUTER_DEBUG=1 OPENCODE_ROUTER_FAULT_INJECT=classifier-timeout opencode ...

# Force the LLM tiebreaker to fail with a malformed-output error
OPENCODE_ROUTER_DEBUG=1 OPENCODE_ROUTER_FAULT_INJECT=classifier-malformed opencode ...
```

Both env vars must be set for activation (DEBUG alone or FAULT_INJECT alone do nothing). Each mode drives the router down a specific fallback path so you can confirm the corresponding `fallbackPath` telemetry field, error budget banner, and graceful-degradation behavior all work end-to-end.

---

## For contributors

New to the feature and want to extend or tune it? This section is task-oriented — find the thing you want to do and it tells you where to start.

### "I want to…"

| Task | Start here |
|---|---|
| Understand why a specific prompt routed the way it did | `opencode debug router --json "<prompt>"` then read fired signals + scores |
| Add a new **prompt signal** (P7, P8, …) | 1. Write extractor in `scorer.ts` following the `extractP1GlobMentions` pattern · 2. Wire into `router.ts` around line 98 (compute + add to `firedSignals`) · 3. Add weight in `weights.json:promptSignalWeights` · 4. Add unit test in `test/router/scorer-prompt.test.ts` |
| Add a new **codebase signal** (C6, …) | 1. Extend `computeCodebaseSignals` in `scorer.ts:185` · 2. Add weight in `weights.json:codebaseSignalWeights` · 3. Add unit test in `test/router/scorer-codebase.test.ts` |
| Tune existing weights or bands | Edit `weights.json`. Run `bun test test/router/calibration.test.ts` to confirm precision/recall/f1 still pass the gate. |
| Add a new **mutation verb** | Add to `weights.json:mutationVerbs`. Add a test in `scorer-prompt.test.ts` under `describe("P6 classifyArchetype")`. Beware substring collisions — `"port"` was rejected because it matches inside `"export"`, `"import"`, etc. |
| Add a new **escape condition** | 1. Add branch in `inherit.ts:shouldInherit` · 2. Add test in `test/router/inherit.test.ts` · 3. Add integration test in `test/router/integration.test.ts` following the `"escape …"` pattern |
| Add support for a **new manifest type** (Cargo.toml, pom.xml, …) for name extraction | Extend `readManifestName` in `workspace-analyzer.ts`. Current pattern dispatches on extension. Pyproject is the existing example. |
| Add a new **fixture workspace** for testing | Create under `src/agent/router/fixtures/workspaces/<name>/`. Add test case in `test/router/workspace-analyzer-real.test.ts`. |
| Force a specific failure mode on a live run | Set `OPENCODE_ROUTER_DEBUG=1` + `OPENCODE_ROUTER_FAULT_INJECT=analyzer-fail\|classifier-timeout\|classifier-malformed`. See `fault-inject.ts`. |
| Trace a decision end-to-end (verbose logging) | Add prints in `router.ts:_route` or run `bun test` on the specific scenario — the test output shows every intermediate value. |

### Test patterns

Most router tests use synthetic inputs rather than live file-system state — fast and deterministic. Two helpers to know:

```ts
import { FakeWorkspaceAnalyzer } from "@/agent/router/workspace-analyzer"
import { MockClassifier } from "@/agent/router/classifier"

// Analyzer that returns whatever shape you want, no filesystem:
const analyzer = new FakeWorkspaceAnalyzer({
  totalFiles: 500, packageCount: 5,
  packages: ["@app/auth", "@app/api", "@app/shared"],
  languageCount: 1, manifestPaths: [], topLevelDirs: ["packages"],
})

// Classifier with a fixed verdict, bypasses all LLM logic:
const classifier = new MockClassifier({
  decision: "coordinator", confidence: "high", reason: "multi-package",
})

await route({ prompt: "...", workspaceRoot: "/any", analyzer, classifier, ... })
```

`RealWorkspaceAnalyzer` hits the filesystem and is only used in `*-real.test.ts` files + the actual runtime flow. Prefer Fake for most tests.

### Where the router plugs into the rest of opencode

- **Entry point from session flow**: `packages/opencode/src/session/prompt.ts:createUserMessage` — calls `autoRoute` from `wire.ts`
- **Entry point from CLI dry-run**: `packages/opencode/src/cli/cmd/debug/router.ts` — uses `route()` directly
- **Effect wrapper**: `wire.ts:autoRoute` bridges the Promise-based `selectAgentMode` into the Effect-based session pipeline, wraps analyzer + classifier with fault-inject
- **Agent registry**: `packages/opencode/src/agent/agent.ts` — defines the `coordinator` agent with `team_create` / `spawn_worker` permissions. The router returns `agentName: "coordinator"` to select it.

### Where calibration and telemetry live

- **Calibration fixture**: `fixtures/calibration.json` (50 labeled prompts). Gate thresholds in `gate.json`. CI test: `test/router/calibration.test.ts`.
- **Daily telemetry**: written to `<workspace>/.opencode/router-decisions-YYYY-MM-DD.jsonl` with hashed prompts. Rotates daily, auto-cleanup after 30 days. See `telemetry.ts`.

---

## File layout

```
packages/opencode/src/agent/router/
├── types.ts                  — All interfaces (RouteInput, RoutingDecision, etc.)
├── scorer.ts                 — P1-P6, C1-C5, composite, bands, floor rules
├── fingerprint.ts            — Workspace structural hash (manifests + top-dirs)
├── workspace-analyzer.ts     — File scan, package walker, language detection
├── classifier.ts             — MockClassifier + GuardedClassifier (circuit breaker)
├── classifier-parse.ts       — JSON + regex output parsers
├── classifier-real.ts        — Real LLM classifier (AI SDK generateText)
├── build-classifier.ts       — Factory: resolves small_model via Provider
├── announce.ts               — Three format fns + emit (TUI toast or stderr)
├── compose-prompt.ts         — {{ROUTER_HINTS}} placeholder injection
├── inherit.ts                — shouldInherit() with 5 escape conditions
├── session-store.ts          — Per-session decision cache
├── error-budget.ts           — 20-turn rolling fallback tracker
├── telemetry.ts              — JSONL writer, daily rotation, cleanup
├── integration.ts            — selectAgentMode orchestrator
├── wire.ts                   — Effect wrapper for session/prompt.ts
├── fault-inject.ts           — OPENCODE_ROUTER_FAULT_INJECT gate for ops debugging
├── version.ts                — routerDecisionVersion hash computation
├── weights.json              — All tunables (signals, bands, tiebreaker config)
├── gate.json                 — Calibration regression thresholds
├── fixtures/
│   ├── calibration.json      — 50 labeled prompts for Wilson LCB gate
│   └── workspaces/           — Fixture repos for tests
└── README.md                 — This file

packages/opencode/src/agent/
├── router.ts                 — Public route() entry point
└── prompt/
    ├── coordinator.txt       — Coordinator system prompt (has {{ROUTER_HINTS}})
    └── tiebreaker.txt        — Frozen LLM classifier prompt
```

Integration point: `packages/opencode/src/session/prompt.ts:createUserMessage`

---

## Configuration

All tunables live in `weights.json`:

```jsonc
{
  "weightsVersion": "v0.1.0",
  "promptSignalWeights": {
    "P1_glob_mentions": 1,
    "P2_package_mentions": 1,
    "P3_scope_keywords": 2,
    "P4_conjunction_chains": 1,
    "P5_explicit_path_count": 0.5,
    "P6_read_only_modifier": -1.0
  },
  "codebaseSignalWeights": {
    "C1_total_files": 1,
    "C2_package_count": 1,
    "C3_affected_subset_size": 1,
    "C4_cross_package_breadth": 2,
    "C5_multilanguage": 1
  },
  "bands": {
    "strongSingleMax": 0.5,
    "leanSingleMax": 1.0,
    "uncertainMax": 2.0,
    "leanCoordinatorMax": 3.0
  },
  "tiebreaker": {
    "enabled": true,
    "timeoutMs": 3000,
    "maxTokens": 150,
    "maxCallsPerSession": 20,
    "circuitBreaker": {
      "consecutiveFailuresToTrip": 5,
      "cooldownMs": 60000
    }
  }
}
```

---

## Telemetry

Every routing decision is logged to `<workspace>/.opencode/router-decisions-YYYY-MM-DD.jsonl`:

```json
{
  "ts": "2026-04-23T14:32:11.842Z",
  "sessionId": "sess_abc",
  "turnIndex": 3,
  "source": "routed",
  "promptSha": "a1b2c3d4...",
  "workspaceFingerprint": "wf_7f3e9c",
  "routerDecisionVersion": "rdv_a1b2c3d4",
  "firedSignalNames": ["P2_package_mentions", "P3_scope_keywords", "C4_cross_package_breadth"],
  "taskArchetype": "mutating-broad",
  "scores": { "prompt": 3.33, "codebase": 6.67, "primary": 3.33, "secondary": 4.67 },
  "classifier": { "invoked": false, "failureMode": null },
  "finalDecision": { "mode": "coordinator", "confidence": "medium" },
  "fallbackPath": null
}
```

**Privacy:** Prompts are SHA-hashed, not stored raw. Files auto-rotate daily and delete after 30 days. Nothing leaves the user's workspace.

---

## Calibration

The router is calibrated against a 50-prompt fixture at `fixtures/calibration.json`. Each prompt has a ground-truth expected label (single/coordinator) and a rationale.

Run the calibration gate:
```bash
cd packages/opencode && bun test test/router/calibration.test.ts
```

Current metrics (heuristic-only, no tiebreaker in tests):
- **Precision: 1.00** (no false positives — never mis-routes single tasks to coordinator)
- **Recall: 0.67** (catches 10/15 coordinator-worthy prompts)
- **F1: 0.80**
- **Wilson 95% LCB: precision=0.72, recall=0.42**

The 5 false negatives are cases where the prompt lacks specific package names or mutation verbs — these correctly land in the uncertain band. With the LLM tiebreaker enabled (production), recall improves further.

Gate: `precision ≥ 0.67, recall ≥ 0.37, f1 ≥ 0.70`. CI fails if these thresholds are breached.

---

## Testing

```bash
cd packages/opencode

# All router tests (unit + integration + calibration)
bun test test/router/

# Specific test suites
bun test test/router/scorer-prompt.test.ts
bun test test/router/calibration.test.ts

# Full opencode test suite (all packages)
bun test --timeout 30000
```

Currently **214 tests, 0 failures**.

Test-file map:

| File | Covers |
|---|---|
| `scorer-prompt.test.ts` | P1-P6 extractors + `classifyArchetype` |
| `scorer-codebase.test.ts` | C1-C5 extractors + `computeCodebaseSignals` |
| `scorer-composite.test.ts` | Weighted composite, AND-gate, band lookup |
| `router.test.ts` | Full `route()` entry point + fallback invariants |
| `inherit.test.ts` | All 5 escape conditions + priority order |
| `integration.test.ts` | `selectAgentMode` end-to-end, error budget, D-escapes + H.2 permission-denied |
| `telemetry.test.ts` | Writer, daily rotation (G.2), 30-day cleanup (G.3) |
| `classifier.test.ts` | `MockClassifier`, `parseClassifierOutput` |
| `classifier-real.test.ts` | `RealClassifier` with mocked model |
| `classifier-resilience.test.ts` | Circuit breaker, rate limit, half-open recovery |
| `fault-inject.test.ts` | Env-var gating, 3 fault modes |
| `workspace-analyzer.test.ts` + `-real.test.ts` | `FakeWorkspaceAnalyzer`, `RealWorkspaceAnalyzer`, `readPyprojectName` |
| `fingerprint.test.ts` | Fingerprint stability + drift |
| `latency.test.ts` | Cold/warm regression thresholds (Phase A) |
| `calibration.test.ts` | 50-prompt precision/recall/f1 gate |
| `announce.test.ts` | Format fns + emit channels |
| `error-budget.test.ts` | 20-turn rolling banner trigger |
| `coordinator-hints.test.ts` | Hint composition into coordinator prompt |
| `compose-prompt.test.ts` | `{{ROUTER_HINTS}}` placeholder injection |
| `session-store.test.ts` | In-memory decision cache |
| `version.test.ts` | `routerDecisionVersion` hash stability |

---

## Validation

End-to-end validation was performed on 2026-04-24 across CLI / TUI / Desktop frontends and real-world SWE-bench tasks. Two-sided decision correctness confirmed:

- Single-package bug (SymPy `is_finite`) → router picks **single** ✓
- Cross-package refactor (opencode monorepo) → router picks **coordinator** ✓

Latency measured well under budget: cold p95 = 10.3 ms (bound: 1500 ms), warm p95 = 1.02 ms (bound: 10 ms).

Full phase-by-phase results, known issues, commits, and outstanding items: [`docs/superpowers/plans/2026-04-24-auto-router-test-results.md`](../../../../../docs/superpowers/plans/2026-04-24-auto-router-test-results.md).

Test plan this was run against: [`docs/superpowers/plans/2026-04-23-auto-router-test-plan.md`](../../../../../docs/superpowers/plans/2026-04-23-auto-router-test-plan.md) (v2).

---

## Design document

Full design rationale is at `docs/superpowers/specs/2026-04-23-opencode-auto-router-design.md`.

Implementation plan is at `docs/superpowers/plans/2026-04-23-opencode-auto-router.md`.

---

## Known limitations

1. **C3 is a proportional estimate.** `WorkspaceAnalysis` doesn't carry per-package file counts, so affected-subset size assumes uniform distribution across packages. Inflates C3 for monorepos with heavily skewed package sizes. v2 fix: add `filesPerPackage: Map<string, number>` to `WorkspaceAnalysis`.

2. **Non-English heuristics are limited.** Mutation verbs and scope keywords are hardcoded English. Non-ASCII prompts default to `mutating-narrow` (neutral) instead of forcing single, but the heuristic signals will miss nuance. The LLM tiebreaker handles these correctly since it's language-agnostic.

3. **Tiebreaker depends on small_model availability.** If the user's provider has no cheap model and no `small_model` config override, the tiebreaker returns `undefined` and uncertain-band prompts always default to single. Cost of this gap: ~5% recall reduction.

4. **Inheritance resets on process restart.** Session store is in-memory only; `/continue` a day later starts fresh. This is by design (staleness escape also kicks in at 30 min).

5. **Calibration fixture needs growth.** 50 prompts is noise-bound. Spec commits to growing to 100 before the first weight change and 200 before the second.

---

## License

Same as opencode.
