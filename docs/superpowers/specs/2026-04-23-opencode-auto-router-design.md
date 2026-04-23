# opencode Auto-Router Design

- **Date:** 2026-04-23
- **Status:** Design (pending user review)
- **Scope:** Automatic routing between single-agent and coordinator (multi-agent) modes
- **Repository:** `anomalyco/opencode`

---

## 1. Motivation

opencode ships a coordinator agent that orchestrates parallel workers for complex, multi-part tasks. Today, activating it is **manual** — users must pass `--agent coordinator`. As a result:

- Users who would benefit from multi-agent coordination don't know to ask for it.
- Users who do ask for it sometimes invoke it on trivial tasks, paying unnecessary overhead.
- There is no mechanism to automatically decide *when* coordinator mode is worthwhile.

The auto-router closes this gap. It analyzes each user turn, measures its scale and complexity against the workspace, and routes to either single-agent or coordinator mode — while leaving `--agent coordinator` intact as an explicit override.

---

## 2. Locked Design Decisions

The following choices were established before the detailed design:

| # | Decision | Value |
|---|---|---|
| 1 | Signal source | **Composite** — both prompt analysis and codebase-aware signals |
| 2 | Routing mechanism | **Heuristics first, LLM tiebreaker on uncertain cases** |
| 3 | Transparency | **Announce the decision** — one-line reason printed before the agent starts |
| 4 | Default bias | **Conservative** — on any uncertainty, default to single-agent |
| 5 | Manual override | **Retained** — `--agent coordinator` (and `--agent <other>`) bypass the router |

Coordinator remains **LLM-driven** after activation: worker count, partitioning, and subtask design stay with the coordinator agent. The router's job is *whether* to coordinate, plus optional starting-point hints.

---

## 3. Architecture Overview

### Module layout

| Path | Role |
|---|---|
| `packages/opencode/src/agent/router.ts` | Entry point — `route()` |
| `packages/opencode/src/agent/router/workspace-analyzer.ts` | Wraps `Ripgrep.Service` + a small package-manifest walker |
| `packages/opencode/src/agent/router/scorer.ts` | Prompt + codebase signal extraction and scoring |
| `packages/opencode/src/agent/router/classifier.ts` | Provider-agnostic LLM tiebreaker |
| `packages/opencode/src/agent/router/announce.ts` | Three announce functions + telemetry records |
| `packages/opencode/src/agent/router/compose-prompt.ts` | Pure coordinator-prompt composition (snapshot-tested) |
| `packages/opencode/src/agent/router/fingerprint.ts` | Workspace fingerprint for inheritance staleness |
| `packages/opencode/src/agent/router/weights.json` | All tunable weights, bands, thresholds, gate |
| `packages/opencode/src/agent/router/gate.json` | Calibration regression gate (auto-updated) |
| `packages/opencode/src/agent/router/fixtures/calibration.json` | 50-prompt labeled calibration set |
| `packages/opencode/src/agent/prompt/tiebreaker.txt` | Frozen classifier system prompt |
| `packages/opencode/src/agent/agent.ts` | **Modified** — adds `selectAgent` flow |
| `packages/opencode/src/agent/prompt/coordinator.txt` | **Modified** — adds `{{ROUTER_HINTS}}` placeholder |
| Session state module (exact location resolved during implementation — see §10) | **Modified** — adds `lastRoutingDecision` field |

### `route()` interface

```typescript
export async function route(input: RouteInput): Promise<RoutingDecision>

interface RouteInput {
  prompt: string
  workspaceRoot: string
  cwd: string                           // may differ from workspaceRoot in subdirs
  modelId: string                       // routing may vary by model class
  sessionHistory?: {
    previousDecision?: RoutingDecision  // for inheritance
    turnIndex: number
  }
  analyzer: WorkspaceAnalyzer           // injected — consumes Ripgrep.Service
  classifier?: LLMClassifier            // mock seam for tests; real impl fires tiebreaker
  config?: RouterConfig
}

interface RoutingDecision {
  mode: "single" | "coordinator"
  reason: string                        // sanitized, user-safe
  confidence: "high" | "medium" | "low" // display
  confidenceScore: number               // [0,1], for tuning
  firedSignals: string[]                // signal names only, not values
  suggestedWorkerCount?: number         // HINT to coordinator, not mandate
  suggestedPartition?: string[][]       // HINT: grouped file/package clusters
  signals: {
    promptScore: number                 // [0, 10]
    codebaseScore: number               // [0, 10]
    llmTiebreakerUsed: boolean
    llmTiebreakerLatencyMs?: number
  }
  decidedAt: number                     // Date.now()
  workspaceFingerprint: string          // for inheritance staleness
}
```

### Integration flow

```
user prompt arrives
  │
  ├─ explicit --agent X override?
  │    ├─ X == coordinator → run analyzer only (skip scorer/classifier); announceOverride("coordinator")
  │    └─ X == other      → announceOverride(X); buildExplicit(X)
  │
  ├─ turn ≥ 2 AND shouldInherit(prior)?
  │    └─ announceInherited(prior); build accordingly
  │
  └─ normal path
       └─ route(input) → RoutingDecision
          announceRouted(decision)
          persistDecisionToSession(sessionId, decision)
          build single or coordinator
```

### Core invariants

1. **Router is pure** — no mutation of config; only side effect is the optional classifier call.
2. **Router never throws**; failures degrade toward single-agent mode.
   - LLM tiebreaker failure → fall back to heuristic score
   - Workspace-scan / heuristic failure → fall back to `single`
   - LLM tiebreaker low-confidence output → `single` (closes the conservative-bias leak)
3. **Router never leaks raw errors to the user.** The `reason` string is always sanitized.
4. **Router is independent of `agent.ts`** — `agent.ts` imports router, not the reverse. Workspace analysis consumes the existing `Ripgrep.Service` via injected `analyzer`, not direct import.
5. **Router runs at most once per session turn.** Turns 2+ inherit unless an escape condition fires.
6. **Caching:** `WorkspaceAnalyzer` caches file/package counts per session.
7. **Telemetry:** every decision appends to `<workspaceRoot>/.opencode/router-decisions-YYYY-MM-DD.jsonl`.

---

## 4. Signal Taxonomy

Two signal families feed the scorer. Each raw signal is normalized to `[0, 1]` *before* weighted combination (no hidden scaling).

### Prompt signals

| Signal | Definition | Fires when | Raw weight | Normalization |
|---|---|---|---|---|
| `P1_glob_mentions` | Glob patterns in prompt | Regex match on glob chars (`**`, `?`, `[`) | +1 per glob, cap 3 | ÷3 |
| `P2_package_mentions` | Actual workspace package names | **Word-boundary match** on names that are **scoped** (`@org/core`) OR **quoted/backticked** OR non-English-word. Bare `core`/`api`/`utils` without markup → not counted. | +1 per unique, cap 4 | ÷4 |
| `P3_scope_keywords` | `all`, `every`, `across`, `entire`, `whole`, `throughout`, `codebase-wide`, `repo-wide` | Only counted **when co-occurring in the same clause with a mutation verb** (`refactor, migrate, rename, update, add, remove, delete, replace, convert, extract, move`). "Make sure all tests pass" → no fire. "Refactor all auth handlers" → fires. | +1 per unique, cap 3 | ÷3 |
| `P4_conjunction_chains` | Conjoined mutation verbs | Only conjoined **mutation verbs**. "read and tell" → no fire. "refactor and rename and deprecate" → +2. | +1 per extra clause, cap 3 | ÷3 |
| `P5_explicit_path_count` | Explicit file/directory paths | Path tokens with `/` **that match a file extension known to the project OR start with a project-dir prefix**. Rejects `http://`, `and/or`, `n/a`. | +0.5 per path, cap 4 | ÷4 |
| `P6_task_archetype` | Classify task type | First mutation verb mapped to `mutating-broad` / `mutating-narrow` / `read-only` / `trivial`. | **-1.0 modifier if read-only**, else 0 | — |

**Explicitly excluded:** bare identifiers, class names, function names (too noisy).

`promptScore = Σ(normalized_signal × weight)` scaled to `[0, 10]`.

### Codebase signals

| Signal | Definition | Source | Raw weight | Normalization |
|---|---|---|---|---|
| `C1_total_files` | Source file count (excluding `.git`, `node_modules`, `dist`, `build`, lockfiles) | `Ripgrep.Service.files()` | Banded: `<50 → 0`; `50–200 → 1`; `200–1000 → 2`; `1000+ → 3` | ÷3 |
| `C2_package_count` | Top-level dirs with `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, etc. | Shallow walk + filename match | Banded: `1 → 0`; `2–3 → 1`; `4–7 → 2`; `8+ → 3` | ÷3 |
| `C3_affected_subset_size` | Files within mentioned packages/paths | Intersect P2+P5 targets with file enumeration | Banded: `<5 → 0`; `5–15 → 1`; `16–40 → 2`; `40+ → 3` | ÷3 |
| `C4_cross_package_breadth` | Does prompt touch ≥2 distinct packages? | `len(unique(P2)) ≥ 2` | Binary: `0` or `2` | ÷2 |
| `C5_multilanguage` | `analyzer.languageCount > 1` | Derived from manifest types | Binary: `0` or `1` | ÷1 |

**Deferred to v2:** dependency graph depth, import cycles, tree-sitter symbol counts.

`codebaseScore = Σ(normalized_signal × weight)` scaled to `[0, 10]`.

### Composite — gate + tiebreaker

```
primaryScore   = min(promptScore, codebaseScore)       // AND-gate: both must clear bar
secondaryScore = 0.6 × promptScore + 0.4 × codebaseScore // tiebreaker only
```

**Rationale for `min`:** coordinator requires **both** an ambitious prompt AND a substrate that supports parallelism. A complex prompt on a 30-file toy repo → tiny `min` → single. Trivial prompt on a 10k-file monorepo → tiny `min` → single.

### Decision bands (applied to `primaryScore`)

| Band | Range | Action |
|---|---|---|
| Strong single | `[0, 3)` | single, high |
| Lean single | `[3, 4.5)` | single, medium |
| Uncertain | `[4.5, 6)` | **fire LLM tiebreaker** |
| Lean coordinator | `[6, 7.5)` | coordinator, medium |
| Strong coordinator | `[7.5, 10]` | coordinator, high |

### Floor rules (override bands)

1. `C3_affected_subset_size < 5 AND promptScore < 6 → force single` (small-scope guard — correctly handles single-package 30-file refactors because C3 scores high).
2. `P6 == read-only → force single` regardless of score.

### Calibration commitment

All weights, bands, mutation-verb set, and the `primaryScore` threshold live in `weights.json` — **not hardcoded**. The file is version-controlled with a `weightsVersion` string and paired with `gate.json` (see §8). The 50-prompt `fixtures/calibration.json` seeds the labeled set.

---

## 5. LLM Tiebreaker (Provider-Agnostic)

Fires only in the uncertain band `primaryScore ∈ [4.5, 6)`. A small, cheap, fast classification call — not a reasoning step.

### Interface

```typescript
interface LLMClassifier {
  classify(input: ClassifierInput): Promise<ClassifierOutput>
}

interface ClassifierInput {
  prompt: string                    // user prompt, untruncated
  firedSignalNames: string[]        // names only — no values (no workspace leak)
  heuristicSummary: {
    taskArchetype: "mutating-broad" | "mutating-narrow" | "read-only" | "trivial"
    fileCount: number
    packageCount: number
    // NOTE: primaryScore and secondaryScore are NOT passed (avoid anchoring)
  }
  timeoutMs: number                 // default 3000
}

interface ClassifierOutput {
  decision: "single" | "coordinator"
  confidence: "high" | "low"
  reason: string                    // ≤ 15 words (post-parse truncated to 80 chars)
}
```

The `classifier` is **injected via `RouteInput`** — production wires the real implementation, tests wire a mock.

### Model selection (provider-agnostic)

Resolved once at router startup, in priority order:

1. If `router.weights.json → tiebreaker.modelRef` is explicitly set → use it.
2. If the user's opencode config defines a `small` or `classifier` model role → use that.
3. Otherwise → fall back to the primary agent's model, constrained to `maxTokens: 150`.

Any model meeting this **capability contract** works:
- Accepts system prompt + user message
- Returns text completion
- Completes a 300-in / 150-out call within `timeoutMs` under normal network conditions
- No tool-use, no vision, no long context required

### Structured output — capability-detected, not assumed

| Capability tier | Strategy |
|---|---|
| Native JSON schema mode (OpenAI `response_format: json_schema`, Gemini structured output) | Use it; parse guaranteed-valid JSON |
| JSON-mode only (unschematized) | Use JSON mode; validate against schema post-parse |
| Neither (plain text) | Regex-strict line format: `DECISION: single\|coordinator\nCONFIDENCE: high\|low\nREASON: <text>` |

Capability detected at startup; per-call overhead zero.

### Frozen system prompt

Lives in `packages/opencode/src/agent/prompt/tiebreaker.txt`:

> You are a routing classifier for a multi-agent coding system. Given a user task and workspace signals, decide whether it should run as a **single agent** (one LLM handles it) or be routed to a **coordinator** (which spawns multiple parallel workers).
>
> Coordinator is worthwhile only when the task has **multiple genuinely independent subtasks that can run in parallel**, each owning non-overlapping files. Trivial tasks, single-file edits, and purely read-only tasks belong on a single agent.
>
> Output strict JSON: `{"decision": "single"|"coordinator", "confidence": "high"|"low", "reason": "<≤15 words>"}`.

Deliberately **no hardcoded "3+" threshold** (policy leak) and **no "if in doubt" clause** (double-counts with the low-confidence mapping below).

### User message template

```
Task: "{prompt}"
Fired signals: {firedSignalNames}
Task archetype: {taskArchetype}
Workspace: {fileCount} files, {packageCount} packages
```

No `primaryScore` or `secondaryScore` — passing them anchors the classifier to the heuristic's lean.

### Budgets

| Parameter | Value | Note |
|---|---|---|
| LLM API `max_tokens` | 150 | provider-level parameter |
| Router config `maxTokens` | 150 | same value, surfaced in `router.weights.json → tiebreaker.maxTokens` |
| `timeoutMs` default | 3000 | local Ollama users raise to 6000+ |
| Retry | Once | **with parse-error context injected** |

### Output → RoutingDecision mapping

| Classifier output | Resolved decision |
|---|---|
| coordinator + high | coordinator, medium |
| coordinator + low | **single (low)** — closes conservative leak |
| single + high | single, medium |
| single + low | single, low |

The tiebreaker never yields `high` final confidence — the router needs heuristic agreement for that.

### Failure handling

| Failure mode | Response |
|---|---|
| Timeout | `single, low` with `fallbackPath: "timeout"` |
| Malformed (after 1 retry) | `single, low` with `fallbackPath: "malformed"` |
| Network / provider error | `single, low` with `fallbackPath: "network"` |
| Circuit breaker open | `single, low` with `fallbackPath: "circuit_open"` |
| Rate limit exceeded | `single, low` with `fallbackPath: "rate_limit"` |
| Mock classifier throws in tests | Surface the error |

Every production failure collapses to `single`, preserving the conservative default.

### Operational controls

```jsonc
// router.weights.json
{
  "tiebreaker": {
    "enabled": true,                    // kill switch
    "modelRef": null,                   // provider-agnostic resolution
    "timeoutMs": 3000,
    "maxTokens": 150,
    "maxCallsPerSession": 20,           // rate limit
    "circuitBreaker": {
      "consecutiveFailuresToTrip": 5,
      "cooldownMs": 60000
    }
  }
}
```

**Prod-build guard:** startup assertion that `classifier instanceof MockClassifier` is false outside test builds.

---

## 6. Integration Points in `agent.ts`

### Hook point

The router fires exactly once in agent selection/construction, **before** any agent is instantiated. All explicit `--agent` overrides short-circuit before routing:

```typescript
async function selectAgent(opts: AgentSelectionOpts): Promise<Agent> {
  // 1. ANY explicit override → short-circuit before routing
  if (opts.userOverride) {
    if (opts.userOverride === "coordinator") {
      const hints = await opts.analyzer.analyze(opts.workspaceRoot, opts.prompt)
      announceOverride("coordinator")
      return buildCoordinator(opts, synthesizeOverrideDecision(hints))
    }
    announceOverride(opts.userOverride)
    return buildExplicit(opts.userOverride, opts)   // plan, review, etc.
  }

  // 2. Turn 2+ inheritance — with escape conditions
  if (shouldInherit(opts)) {
    const prior = opts.sessionHistory!.previousDecision!
    announceInherited(prior)
    return prior.mode === "coordinator" ? buildCoordinator(opts, prior) : buildSingle(opts)
  }

  // 3. Normal routing
  const decision = await route({...})
  announceRouted(decision)
  await persistDecisionToSession(opts.sessionId, decision)
  return decision.mode === "coordinator" ? buildCoordinator(opts, decision) : buildSingle(opts)
}
```

**Manual `--agent coordinator` still gets partition hints** — the analyzer runs (cheap); only scorer/classifier are skipped.

### Inheritance — guarded by escape conditions

`shouldInherit` makes inheritance a bias, not a lock-in. **Priority order (first match wins):**

| Priority | Condition | Effect |
|---|---|---|
| 1 | Prompt starts with `/reroute` | Re-route (explicit user intent) |
| 2 | Workspace fingerprint drift | Re-route (workspace changed) |
| 3 | `decidedAt` > 30 min ago | Re-route (stale session) |
| 4 | Prompt < 80 chars AND no file refs | Re-route (trivial follow-up) |
| 5 | Prior was coordinator AND current archetype is read-only | Re-route |
| — | None of the above | Inherit prior decision |

### Workspace fingerprint — structurally stable

```typescript
function computeFingerprint(workspaceRoot: string): string {
  const manifests = globSorted([
    "package.json", "*/package.json",           // depth 1
    "pyproject.toml", "*/pyproject.toml",
    "Cargo.toml", "*/Cargo.toml",
    "go.mod", "*/go.mod",
    "pom.xml", "*.sln"
  ], { cwd: workspaceRoot })
  const topDirs = listTopLevelDirs(workspaceRoot).sort()
  const basename = path.basename(workspaceRoot)
  return sha256([...manifests, "|", ...topDirs, "|", basename].join("\n")).slice(0, 16)
}
```

Flips only on structural change — new manifest, new/removed top-level directory, repo rename. Not on ordinary file changes.

### Three announce functions

```typescript
function announceOverride(agent: string): void
function announceInherited(decision: RoutingDecision): void
function announceRouted(decision: RoutingDecision): void
```

Each writes a telemetry record with `source: "override" | "inherited" | "routed"`.

Output format (fixed & greppable — snapshot-tested):

```
→ Routing: coordinator (manual override)                          [source=override]
→ Routing: coordinator · inherited from previous turn             [source=inherited]
→ Routing: coordinator · 8 files across 3 packages               [source=routed]
→ Routing: single · single-package edit                          [source=routed]
```

### Announce channel

Emitted via opencode's transcript event layer (same mechanism that emits agent-lifecycle events). Three adapters:

| Frontend | Rendering |
|---|---|
| TUI (interactive) | Structured event, boxed prefix line before agent stream |
| Non-TTY (CI, pipe) | Single stderr line, no ANSI |
| JSON-log mode | `{"event": "routing", ...}` record |

**Ordering guarantee:** announce emitted-and-flushed *before* agent emits first token. No interleaving.

### Coordinator prompt composition — `{{ROUTER_HINTS}}` placeholder

`coordinator.txt` is modified exactly once to add a `{{ROUTER_HINTS}}` placeholder at a deliberate insertion point (after the role/workflow section, before the anti-patterns section).

```typescript
// router/compose-prompt.ts — pure function, snapshot-tested
export function composeCoordinatorPrompt(
  base: string,
  hints: HintBlock | null
): string {
  const placeholder = "{{ROUTER_HINTS}}"
  if (!hints) return base.replace(placeholder, "")
  return base.replace(placeholder, renderHintBlock(hints))
}
```

The rendered hint block is advisory:

```
## Router Hints (advisory — override if you disagree)

The auto-router analyzed this task before you started. Its guesses:
- Suggested worker count: 3
- Suggested partition:
  - Worker A: packages/auth/**, packages/session/**
  - Worker B: packages/api/routes/**
  - Worker C: packages/shared/types/**
- Signals that triggered coordinator: cross-package (auth, api, session), mutating-broad archetype, 12 files in affected subset

Use these as a starting point. You are free to spawn fewer or more workers, or repartition, based on your own judgment. Do not feel obligated to match the router's partition if you see a better one.
```

### Permissions

No changes required. The existing `Permission.merge` on coordinator registration continues to apply.

### Session plumbing

```typescript
interface SessionState {
  lastRoutingDecision: RoutingDecision | null
}
```

- In-memory within a session: always.
- Serialized to session store: yes; `workspaceFingerprint` + `decidedAt` provide staleness detection.
- Persist-failure: current turn proceeds; next turn re-routes (treating `lastRoutingDecision` as `null`).

### Error propagation

| Failure | Response |
|---|---|
| `route()` internal error | Router never throws; returns `single, low` |
| `buildCoordinator` fails | Fall back to `buildSingle`, visible warning: `⚠ Coordinator build failed — falling back to single agent.` |
| `buildSingle` fails | Propagate (critical path, no silent fallback) |
| `persistDecisionToSession` fails | Log to telemetry + stderr warning; current turn proceeds |
| `analyzer.analyze` fails on override path | Manual coordinator proceeds without hints; no user-visible warning |

---

## 7. Error Handling & Observability

### Failure-mode catalog

All failure modes in one place, in order of severity:

| # | Failure | User-visible impact | Response | Logged to |
|---|---|---|---|---|
| 1 | `buildSingle` fails | Turn cannot proceed | **Propagate (ONLY hard fail)** | stderr + debug |
| 2 | `buildCoordinator` fails | Turn proceeds on single | Warning line | stderr + telemetry |
| 3 | Workspace scan crashes | Heuristics skipped | `single, low` | telemetry |
| 4 | Scorer throws | Same as #3 | `single, low` | telemetry + debug |
| 5 | Tiebreaker timeout | Tiebreaker skipped | `single, low` | telemetry |
| 6 | Tiebreaker malformed | Same as #5 | `single, low` | telemetry |
| 7 | Tiebreaker low-confidence coordinator | (Designed) | `single` | telemetry |
| 8 | Circuit breaker trip | Tiebreaker disabled 60s | Band-5 → `single, low` | telemetry + stderr |
| 9 | Persist fails | Next turn re-routes | Log only; current turn OK | stderr + debug |
| 10 | Rate limit exceeded | Tiebreaker skipped | `single, low` | telemetry |
| 11 | Fingerprint mismatch on inherit | Re-routes (designed) | Not an error | telemetry |
| 12 | Override-path analyzer fails | Coordinator without hints | No warning | telemetry |

**Principle:** exactly one failure (`buildSingle`) propagates. Everything else degrades gracefully toward single-agent mode.

### Error-budget banner

The circuit breaker state carries a **20-turn rolling counter** of fallback-path hits. Crossing threshold (4/20) prefixes the next announce line with a one-shot banner:

```
⚠ Router degraded — 5/20 recent turns fell back to single-agent mode.
  Run `router:health` for details.
→ Routing: single · single-package edit
```

Banner appears at most once per 20-turn window. This surfaces compounding failures that would otherwise be silent.

### Three logging tiers

| Tier | Destination | Audience | Contents |
|---|---|---|---|
| User-facing | stderr / TUI transcript | End user | Announce line, coordinator-build warnings, budget banner |
| Telemetry | `.opencode/router-decisions-YYYY-MM-DD.jsonl` | Calibration | Every decision, one JSONL record per turn |
| Debug | `.opencode/router-debug.log` | Developer | Gated on `OPENCODE_ROUTER_DEBUG=1`. Size-rotated, 2 files retained (10 MB each). |

### Telemetry record schema

```json
{
  "ts": "2026-04-23T12:34:56.789Z",
  "sessionId": "sess_abc123",
  "turnIndex": 3,
  "source": "routed",
  "prompt_sha": "ab12cd34...",
  "workspaceFingerprint": "wf_7f3e...",
  "routerDecisionVersion": "rdv_a1b2c3d4",
  "firedSignalNames": ["P1_glob_mentions", "C4_cross_package"],
  "taskArchetype": "mutating-broad",
  "scores": { "prompt": 5.2, "codebase": 4.8, "primary": 4.8, "secondary": 5.04 },
  "classifier": {
    "invoked": true,
    "modelRef": "openai/gpt-4o-mini",
    "latencyMs": 840,
    "outcome": "coordinator:high",
    "failureMode": null
  },
  "finalDecision": { "mode": "coordinator", "confidence": "medium" },
  "fallbackPath": null
}
```

**Signal names only** — never values. `P2_package_mentions` stores the name, never `auth-service,billing-api`.

### Versioning — single hash

```
routerDecisionVersion = sha256(routerVersion + "|" + weightsVersion + "|" + tiebreakerPromptSha).slice(0, 12)
```

Bumps when any component changes. Calibration segregates data by `routerDecisionVersion`. The three individual strings still appear in `router:health` output for human diagnosis.

### Telemetry file strategy

- **Daily rotation:** `router-decisions-YYYY-MM-DD.jsonl`, one per UTC day.
- **30-day retention**, opportunistic cleanup at router startup.
- **Streaming reads** — `router:health` and `tune.ts` never full-parse a file into memory.

### Opportunistic retention cleanup

```typescript
async function opportunisticCleanup(workspaceRoot: string) {
  await unlinkIfOlderThan(".opencode/router-decisions-*.jsonl", 30)  // days
  await unlinkIfOlderThan(".opencode/router-prompts-*.jsonl",   30)
}
```

No cron dependency. Self-healing — cleanup runs where the writer runs.

### Privacy

**Telemetry privacy (local-only, guaranteed):**

| Data | Stored locally | Leaves machine |
|---|---|---|
| Decision records | yes | no |
| Workspace fingerprint hash | yes | no |
| Debug log (env-gated) | yes | no |
| Raw prompts (opt-in) | yes | no |

**Inference privacy (the tiebreaker makes network calls):**

| Data | Sent to LLM provider | When |
|---|---|---|
| User prompt text | **yes** | Every tiebreaker call (uncertain-band, ~20% of turns) |
| Fired signal names | **yes** | Same |
| Task archetype, file count, package count | **yes** | Same |
| Workspace package names or paths | **no** (not in user message) | — |

**Equivalence statement:** the tiebreaker sends the user's prompt to the configured provider, identical to what the main agent does. It is not additional exposure — it is the same exposure once more per uncertain-band turn. If `tiebreaker.enabled: false` or the configured model is local (Ollama), no additional network traffic occurs.

### Health aggregates — `bun run router:health`

Derived from JSONL, constant-memory streaming:

```
Router health (last 24h, 287 decisions):
  routed:       218  (76%)
  inherited:     47  (16%)
  override:      22   (8%)

  Decisions by mode:
    single:       171 (60%)
    coordinator:  116 (40%)

  Tiebreaker usage:    49 / 218 routed requests (22% entered uncertain band)
  Tiebreaker outcomes: coordinator=18, single=27, fallback=4
  Tiebreaker p50 latency: 620ms    p95: 1840ms
  Circuit breaker trips: 0
  Fallback rate: 4 / 49 (8%)  ← warn if > 5%

  Versions:  router=v0.3.1  weights=v1.2.0  tiebreakerPrompt=sha ab12cd
  Combined routerDecisionVersion: rdv_a1b2c3d4
```

### Calibration loop — maintainer-only

```
production decisions → JSONL → reviewer labels sample → tune.ts grid-searches weights → weights.json v2
```

**This is a maintainer-only workflow.** End users opt into raw-prompt capture (`router.telemetry.capturePrompts: true`) to contribute data out-of-band (e.g., a GitHub issue). There is no in-product labeling UI.

### Debug surfaces

| Mode | Behavior | Cost |
|---|---|---|
| `--route-explain` (default) | Prints heuristic breakdown; **skips tiebreaker**, labels uncertain output as "would invoke tiebreaker" | Zero LLM cost |
| `--route-explain=full` | Actually invokes the tiebreaker (if band uncertain); shows verdict and latency; exits without running the agent | One tiebreaker call |
| `OPENCODE_ROUTER_DEBUG=1` env | Writes the same breakdown to `router-debug.log` on every real run | None (no extra LLM) |

---

## 8. Testing Strategy

### Four test layers

| Layer | Scope | Speed | CI |
|---|---|---|---|
| Unit | One module, no network | <5ms | always |
| Integration | Full `route()` with injected fakes + **stacking cases** | <50ms | always |
| Calibration | **Wilson LCB vs baseline-driven gate** | ~2s | always |
| Smoke | Real LLM, **provider matrix**, skip-with-warning | ~30s | **no — manual, hosted-provider required** |

**Principle:** CI must be deterministic. Smoke runs only when a maintainer explicitly commits to a calibration change.

### Per-module unit checklists

**`scorer.ts`:** P1–P6 fire correctly + noise-fix regressions (P2 word-boundary, P3 mutation-verb co-occurrence, P4 conjoined mutation verbs, P5 extension/prefix), normalization, `min`-gate composite, floor rules.

**`workspace-analyzer.ts`:** fixtures (empty, single-pkg, small/large monorepo, polyglot), per-session cache, ignore globs, permission-denied graceful degradation.

**`fingerprint.ts`:** structural stability — identical workspaces identical, `.md` add unchanged, manifest add changed, top-dir add changed, rename changed.

**`classifier.ts`:** all three parse modes, malformed outputs (missing `decision`, non-enum, truncated, empty), retry-with-error-context, timeout with fake clock, circuit breaker (5 fails → trip → half-open at 60s), rate limit via explicit config, prod-build MockClassifier assertion.

**`compose-prompt.ts`:** placeholder stripped cleanly (no hints), hint block injected (with hints), snapshot test, missing-placeholder throws.

**`announce.ts`:** three functions produce exact format strings (snapshot-tested), telemetry `source` tag correct, non-TTY → stderr no ANSI.

**`health.ts` / `tune.ts`:** streaming aggregator on 100k-line fixture, rolling window, `routerDecisionVersion` segregation, opportunistic cleanup (unlink 31d, keep 29d).

### Integration test matrix

**Happy paths:**
| Scenario | Expected |
|---|---|
| Trivial prompt in small repo | single, high |
| "Refactor all auth handlers across packages" in 5-pkg monorepo | coordinator, medium |
| Read-only prompt in large monorepo | single, high (floor rule 2) |
| Single-package 30-file refactor | coordinator, medium (C3 carries it) |
| Tiny workspace + complex prompt | single (min-gate) |
| Complex prompt + 2-file toy repo | single (min-gate) |

**Failure-mode tests:** one per row in the 12-row catalog; asserts correct `fallbackPath` + final mode + telemetry record.

**Stacking failure tests:**
```typescript
test("scan crash + tiebreaker timeout in same turn")   // first-hit wins
test("4 of 20 recent turns hit fallback → banner fires")
test("banner suppressed within same 20-turn window")
test("staleness + fingerprint drift both trip on same inherit attempt")
test("rate-limit exhaustion + circuit-breaker-open simultaneously")
```

The 20-turn error budget banner is load-bearing test coverage, not decoration.

### Escape-condition priority — truth table

All 32 combinations of the 5 escape flags. First-match-wins semantics:

```typescript
// [reroute, drift, stale, shortFollow, archetypeFlip] → expectedEscape
[true,  *,    *,    *,    *    ] → "reroute"
[false, true, *,    *,    *    ] → "drift"
[false, false,true, *,    *    ] → "stale"
[false, false,false,true, *    ] → "short_follow"
[false, false,false,false,true ] → "archetype"
[false, false,false,false,false] → "inherit"
```

### Calibration gate — baseline-driven

No aspirational numbers. Before lock, the fixture runs against initial implementation + two negative controls:

| Baseline | Purpose |
|---|---|
| Always-single | Lower bound: does any-router beat "never coordinate"? |
| Random (50/50) | Noise floor |
| Heuristics-only | What heuristics alone achieve |
| Full router | Production target |

**Gate formula (committed):**
```
gate.precision = max(0.65, trailing_run.precision - 0.05)
gate.recall    = max(0.65, trailing_run.recall    - 0.05)
gate.f1        = max(0.60, trailing_run.f1        - 0.05)
```

Monotonic ratchet: `median(trailing_10_runs) - 0.05`. Recorded to `gate-history.jsonl`.

**Metric is Wilson 95% lower confidence bound, not point estimate:**
```typescript
expect(wilsonLCB(tp, tp + fp)).toBeGreaterThanOrEqual(gate.precision)
```

n=50 gives wide CIs; Wilson LCB naturally rewards fixture growth.

**Growth targets:**
| Milestone | Fixture size |
|---|---|
| v0 ship | 50 |
| First weight change | ≥ 100 |
| Second weight change | ≥ 200 |

### Smoke test — provider matrix

```typescript
const providers = [
  { name: "openai-mini",     modelRef: "openai/gpt-4o-mini",      requiredEnv: "OPENAI_API_KEY" },
  { name: "anthropic-haiku", modelRef: "anthropic/claude-haiku-*", requiredEnv: "ANTHROPIC_API_KEY" },
  { name: "ollama-local",    modelRef: "ollama/llama3.1:8b",       requiredEnv: null },
]
// At least one HOSTED provider must run; local-only cannot satisfy the smoke gate.
```

Skip-with-warning (not silent) when credentials missing. Maintainers run before merging changes to `tiebreaker.txt`, `weights.json`, or classifier parse logic.

### Polyglot fixture — labeled with ground truth

Three prompts paired with `fixtures/workspaces/polyglot/`:

```json
[
  { "prompt": "Add a new API endpoint", "workspace": "polyglot",
    "expected": "single", "rationale": "Single-file addition; multi-lang repo doesn't imply multi-lang work" },
  { "prompt": "Port auth logic from Python to TypeScript", "workspace": "polyglot",
    "expected": "coordinator", "rationale": "Cross-language port with clear parallel work" },
  { "prompt": "Update all README files", "workspace": "polyglot",
    "expected": "single", "rationale": "Multi-lang repo but trivial/mechanical change" }
]
```

### Coordinator hint-consumption test (co-ships with router)

`packages/opencode/src/agent/tests/coordinator-hints.test.ts`:
1. Populated placeholder → coordinator system prompt contains hint block
2. Empty placeholder → no dangling whitespace or `{{ROUTER_HINTS}}` literal
3. Snapshot of composed prompt for each variant

**Hints cannot ship without this test.**

### Explicit non-goals

1. Cross-platform FS (tests run on Linux+macOS; Windows best-effort)
2. Real LLM providers in CI (always mocked)
3. Long-running multi-day sessions (fake-clocked)
4. Coordinator's *use* of hints — covered by the named hint-consumption test, not here
5. End-to-end UX (manual QA)

### Test fixtures inventory

| File | Purpose |
|---|---|
| `fixtures/calibration.json` | 50+ labeled prompts |
| `fixtures/workspaces/empty/` | Edge case |
| `fixtures/workspaces/single-pkg/` | One `package.json`, ~20 files |
| `fixtures/workspaces/monorepo-small/` | 3 packages, TS |
| `fixtures/workspaces/monorepo-large/` | 10 packages, TS |
| `fixtures/workspaces/polyglot/` | TS + Python + Rust, for C5 |
| `fixtures/prompts/*.txt` | Named samples |
| `fixtures/classifier-outputs/*.json` | Mock classifier responses per parse mode |

### Polish items (acknowledged)

- **Snapshot discipline:** `CODEOWNERS` entry `__snapshots__/ @router-maintainers`. PR template checkbox: "Snapshot changed? Paste before/after diff."
- **Prod-build assertion:** marked `@todo` in `classifier.test.ts`; covered by manual QA on production builds.
- **Rate-limit test:** explicit `classifier.configure({ maxCallsPerSession: 3 })` in test body; default decoupled.

---

## 9. Future Work (v2)

Deliberately deferred from v1:

- **Dependency-graph signals** — depth, import cycle detection, tree-sitter symbol counts. The current file/package bands capture common cases; v2 can add semantic signals.
- **Configurable bias** (per the original Option C from the routing-sensitivity question) — expose a user-facing setting to tune conservative vs aggressive. Requires real calibration data first.
- **In-product labeling UI** — let opt-in users retroactively label their own routing decisions for calibration.
- **Cross-session learning** — use accumulated telemetry to automatically retune weights over time (requires stronger privacy story).
- **Worker-count heuristic** — the router currently leaves worker count to the coordinator. A future version could compute a firm count based on partition signals.

---

## 10. Open Questions for User Review

These assumptions in the design depend on opencode internals that should be verified during the implementation plan:

1. **Session state module location.** The `lastRoutingDecision` field needs a home. The implementation plan should locate the session model and either extend it or propose a wrapper.
2. **Transcript event layer.** The announce channel assumes opencode has a unified event layer for TUI/non-TTY/JSON-log. If not, the fallback is direct `process.stdout.write` / `process.stderr.write` with the same ordering guarantee.
3. **Model role configuration.** The tiebreaker's step-2 resolution (opencode's `small`/`classifier` model role) depends on whether opencode config already has a concept of model roles. If not, step 2 is skipped and step 3 (primary agent fallback) is reached directly.
4. **Ripgrep.Service cache behavior.** The per-session cache relies on `Ripgrep.Service` being cheap to re-invoke within a session. If it already caches internally, `WorkspaceAnalyzer`'s caching layer is thin.

None of these block the design. Each is a small implementation-plan question.
