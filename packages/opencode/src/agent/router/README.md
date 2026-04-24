# Auto-Router

Automatic routing between **single-agent** and **coordinator (multi-agent)** mode for opencode.

The router analyzes each user prompt and the workspace, then decides whether to run the task on a single agent (default) or escalate it to the coordinator, which spawns multiple parallel workers. Users never have to manually pick coordinator mode — it just happens when the task warrants it.

Works across **CLI**, **TUI**, and **Desktop** frontends.

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
→ Routing: coordinator (manual override)
```

### To disable the LLM tiebreaker

Edit `packages/opencode/src/agent/router/weights.json`:
```json
{ "tiebreaker": { "enabled": false } }
```

This makes the router 100% heuristic — no additional LLM calls, at the cost of slightly lower recall on ambiguous prompts (they default to single-agent).

---

## How it works

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

## Safety nets

- **Router never throws** — any error falls back to single-agent, user's turn always proceeds
- **Error budget banner** — if 4 of 20 recent turns hit fallback, a warning appears
- **Circuit breaker** — LLM tiebreaker disabled for 60s after 5 consecutive failures, with half-open recovery
- **Rate limiter** — max 20 tiebreaker calls per session
- **Conservative default** — every ambiguity resolves to single-agent

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

Currently **210 tests, 0 failures**.

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
