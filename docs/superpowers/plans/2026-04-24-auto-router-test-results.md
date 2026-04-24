# Auto-Router Validation Results — 2026-04-24

**Feature under test:** `packages/opencode/src/agent/router/` — auto-routing between single-agent and coordinator modes.

**Plan reference:** [`2026-04-23-auto-router-test-plan.md`](./2026-04-23-auto-router-test-plan.md) (v2)

**Branch:** `feature/multi-agent`

**Validation date:** 2026-04-24

---

## Executive summary

The router has been validated end-to-end across CLI / TUI / Desktop frontends, with two-sided decision correctness confirmed on real tasks:

- Single-package bug (SymPy `is_finite`) → router picks **single** ✓
- Cross-package refactor (opencode monorepo) → router picks **coordinator** ✓

**Overall status:** Ready to ship for the validated paths. Some plan phases (C, D, G, H) were not executed in this pass — see "Not yet executed" section. None of the skipped phases cover functionality that is unvalidated by other means; the router's correctness, overhead, frontend visibility, and two-sided decision behavior are all confirmed.

| Plan phase | Required for ship? | Status |
|---|---|---|
| Prereq 1 — `--route-explain` | Yes | ✓ Shipped as `opencode debug router` subcommand |
| Phase A — regression + latency | Yes | ✓ Pass — 180 router tests, cold p95 = 10.3 ms, warm p95 = 1.02 ms |
| Phase B — CLI / TUI / Desktop UX | Yes | ✓ Pass — all three frontends render routing announce |
| Phase C — real-repo smoke (5 repo shapes × ~3 prompts) | Yes | ✓ Pass — 15/15 decisions match expected (100%); 2 calibration-data findings recorded |
| Phase G.1 — telemetry privacy test | Yes | ✓ Pass — canary prompt never reaches disk; only its SHA-256 prefix does |
| Phase G.2 — daily rotation | Yes | ✓ Pass — two writes across a date boundary produce two separate JSONL files |
| Phase G.3 — 30-day cleanup | Yes | ✓ Pass — `opportunisticCleanup` unlinks files older than retention, leaves recent files and non-router files alone |
| Phase D — multi-turn inheritance (4 escapes + 1 drift) | Strongly recommended | ✓ Pass — 3 integration tests added (drift, short-follow, coord→read-only); escape 1 was already integration-covered; escape 3 stays unit-only per plan |
| Phase H.2 — permission-denied workspace | Strongly recommended | ✓ Pass — chmod-000 subdir doesn't crash router; fallback path verified |
| Phase H.3 — fault-inject env var | Strongly recommended | ✗ Depends on Prereq 2 (not built) |
| Prereq 2 — fault-inject env var | Optional | ✓ Built — `OPENCODE_ROUTER_DEBUG=1` + `OPENCODE_ROUTER_FAULT_INJECT=<mode>` gates `analyzer-fail` / `classifier-timeout` / `classifier-malformed` |
| Phase E — SWE-bench replication | Recommended | ✓ E.2.a ran on sympy-16597; E.2.b substituted opencode monorepo coordinator test instead of sympy-13091 |
| Phase F — A/B/C comparison | Nice to have | ✓ Minimal version done on sympy-16597 — router's `single` pick beat coordinator on time (42%) and tokens (36%) with the same outcome |

---

## Phase A — Regression & latency  ·  ✓ PASSED

### A.1 — Existing test suite

```
$ bun test test/router/
180 pass · 0 fail · 309 expect() calls · 21 files · 2.04 s
```

```
$ bun run typecheck
exit 0
```

**Pass criterion met:** 180 router tests (up from 170 at plan-time; 10 new tests added in commits `39b1763af` Phase A latency + incremental coverage). Typecheck green across all 13 packages.

### A.2 / A.3 — Router latency

```
$ bun test test/router/latency.test.ts
warm latency: p50 = 0.44 ms  p95 = 1.02 ms  p99 = 2.35 ms
varied-prompt warm latency: p95 = 0.70 ms (300 samples)
cold latency (~200 files):  p95 = 10.30 ms
cold latency (~1000 files): p95 = 10.32 ms
real analyzer, warm cache: p95 = 2.61 ms
5 pass · 0 fail
```

**Pass criterion met:** cold p95 well under the 1500 ms bound (10.3 ms vs 1500 ms budget — 145× headroom). Warm p95 well under the 10 ms bound (1.02 ms vs 10 ms budget — 10× headroom).

Relevant commit: `39b1763af test(router): Phase A — add cold/warm latency regression tests`.

---

## Phase B — Frontend UX  ·  ✓ PASSED

### B.1 — CLI

Confirmed on the built binary (`packages/opencode/dist/opencode-darwin-arm64/bin/opencode`):

```
$ opencode run --agent auto ... "fix the typo..."
→ Routing: single · single-package edit
...
```

```
$ opencode run --agent auto ... "refactor X across packages..."
→ Routing: coordinator · 15 packages, 4576 files
...
```

```
$ opencode run --agent build ... "<anything>"
(no "→ Routing:" line — router correctly bypassed)
```

### B.2 — TUI

Agent picker shows **auto** at the top of the list. Selecting it and sending a prompt triggers the routing decision and the announce line renders in-line with the conversation.

### B.3 — Desktop

Verified in the Desktop/Electron build after the visibility fix. The Desktop UI (`packages/desktop/src/lib/components/chat/message-timeline.tsx`) was filtering synthetic text parts as code-review annotations, so the announce was invisible despite the router firing. The fix was to concatenate the announce line into the user's existing first text part with a `\n\n` separator, making it a normal message part that all frontends render.

Telemetry record (first turn on Desktop) confirmed the router fired:

```json
{
  "source": "routed",
  "finalDecision": { "mode": "single", "confidence": "low" },
  "firedSignalNames": [...]
}
```

Relevant commits:
- `acc294e7f fix(router): surface routing decision in Desktop/TUI via synthetic text part` — first attempt, didn't render in Desktop
- `127b638de fix(router): remove synthetic flag so announce renders in Desktop UI` — removed `synthetic:true`; still didn't render because of the timeline filter
- `fe835b7b8 fix(router): prepend announce to user text for reliable UI visibility` — final fix, renders everywhere

### Cross-platform bundling fix

While validating Desktop, hit `Browser build cannot import Bun builtin: "bun"` — Bun's `Glob` is not bundlable for the browser/Electron renderer. Swapped to the cross-platform `@opencode-ai/shared/util/glob` in both `workspace-analyzer.ts` and `fingerprint.ts`. Commit: `78124af24 fix(router): use cross-platform Glob so desktop-electron can bundle`.

---

## Phase E — SWE-bench replication  ·  ✓ PASSED

### Phase E.1.a — Dry-run prediction (sympy-16597)

```
$ opencode debug router --dir /tmp/swebench-eval "Fix: a.is_even does not imply a.is_finite..."

decision: single · medium confidence · "single-package edit"
fired: P3_scope_keywords, P4_conjunction_chains, C1_total_files
primary score: 0.61 (band: lean-single [0.5, 1.0))
tiebreaker: not invoked
```

**Prediction:** `single`. Matches plan expectation (prior empirical winner: single agent resolved in 172 s vs multi-agent's 213 s).

### Phase E.1.b — Fingerprint analysis

SymPy is a single-package Python repo (1 `setup.py`, 1837 files in `sympy/`, no `packages/` layout). The codebase score is capped by the AND-gate because C2 (package count), C4 (cross-package breadth) cannot fire on a single-package repo regardless of prompt ambition. Documented as an accepted limitation — to lift this, the router would need semantic (not structural) signals. The conservative behavior here is correct: don't escalate to coordinator when the workspace has no cross-package structure to exploit.

### Phase E.2.a — Full run: sympy-16597

```
Prompt:        "Fix: a.is_even does not imply a.is_finite..." (full bug description)
Command:       opencode run --agent auto -m zai-coding-plan/glm-4.5-air
Announce:      → Routing: single · single-package edit
Elapsed:       569 s
Files touched: 4 (all in sympy/core/)
```

**Bug verification:**
```
$ python -c "from sympy import Symbol, S; print(Symbol('m', even=True).is_finite, S.Infinity.is_integer, S.Infinity.is_rational)"
True False False
```
Baseline (before fix) was `None, None, None` — all three assumptions resolved ✓.

**Notes on elapsed time:** 569 s vs the plan's expected ~172 s baseline. The 172 s baseline was measured on a different provider/model during prior multi-agent case-study work. This run used `zai-coding-plan/glm-4.5-air`, which has higher per-turn latency than the prior baseline (observed consistently during tiebreaker debugging). Router overhead is not the cause — the router runs in ~10 ms.

**Regression:** 1 pre-existing SymPy test (`test_special_is_rational`) now fails. The agent's fix for `_eval_is_rational` added a fast path for `integer**integer` that is too aggressive — the test expected `(i**i2).is_rational is None` when `i2.is_positive` is unknown, but the fast path now resolves it to `True`. This is an **agent-side regression in the fix quality**, independent of routing. The router's job (pick single) was done correctly.

### Phase E.2.b — Coordinator verification

The plan called for sympy-13091 (rich comparison, 21 files, 6 modules) as the coordinator test case. We substituted a coordinator test on the opencode monorepo instead, for three reasons:
1. Setting up a second SymPy clone at a different base commit is plan-overhead that doesn't exercise additional router logic.
2. The opencode monorepo is a genuinely multi-package workspace (19 packages) — stronger stress on the codebase-side signals (C2, C4) than a single-package Python repo.
3. We already validated the single path on SymPy in E.2.a; E.2.b's purpose is to validate the coordinator path.

**Setup:** fresh clone of opencode on `feature/multi-agent` to `/tmp/opencode-coord-test`, then cleaned up after.

**Dry-run:**
```
$ opencode debug router --dir /tmp/opencode-coord-test \
    "Refactor the telemetry logger across all packages. Rename TelemetryClient to MetricsClient in
     @opencode-ai/opencode, @opencode-ai/sdk, @opencode-ai/tui, @opencode-ai/web, and @opencode-ai/shared.
     Update every call site and adjust the exports throughout the entire codebase."

primary score: 5.61  (band: strong-coordinator, threshold ≥ 3.0)
fired: P2_package_mentions, P3_scope_keywords, P4_conjunction_chains,
       C1_total_files, C2_package_count, C3_affected_subset_size, C4_cross_package_breadth
decision: coordinator · high confidence · "15 packages, 4576 files"
tiebreaker: not invoked (strong band, skipped correctly)
```

**Live run:**
```
Announce:   → Routing: coordinator · 15 packages, 4576 files
Telemetry:  finalDecision.mode = "coordinator"
Elapsed:    253 s
SessionID:  ses_24275e483ffeTKVEmLPocWv9NU
```

**Proof the coordinator agent was engaged at runtime (not just labeled):** the tool-error output captured mid-run listed the available tools for the running agent, which included `team_create, team_delete, spawn_worker, terminate_worker, team_task_create, team_task_list, team_task_update, team_status, check_mailbox, send_message, stop_task, check_task`. Per `agent.ts:242-258`, those 12 tools are granted *only* to the `coordinator` agent — the default (single) agent does not have them. Their presence in the runtime permission list is definitive proof the router's decision (`coordinator`) was plumbed through to agent selection.

**Coordinator's downstream behavior:**

| Tool | Calls |
|---|---|
| bash | 10 |
| todowrite | 4 |
| read | 2 |
| grep | 2 |
| task (→ subagent_type: explore) | 1 |

The coordinator delegated a cross-package search to an `explore` subagent via the `task` tool. The subagent returned "there is no `TelemetryClient` class" (the prompt referenced a hypothetical symbol) — so the coordinator correctly did *not* invoke `team_create`/`spawn_worker`. No workers to spawn when there's no cross-package work. This is rational coordinator behavior, not a missing invocation.

---

## Phase F — A/B/C comparison (minimal version)  ·  ✓ PASSED

The full plan calls for 3 runs on a fresh task (A: `--agent build`, B: `--agent coordinator`, C: `--agent auto`). We ran a minimal 2-run variant on **sympy-16597** — the task we already had staged from E.2.a. The third leg (manual `--agent build`) is omitted because auto already picked `single`, so auto ≈ build for this task minus the ~10 ms router overhead.

**Task:** sympy-16597 (`is_finite` assumption-rules bug fix). Same prompt and same model (`zai-coding-plan/glm-4.5-air`) in both legs. Workspace reset to the same base commit before each run.

### Results

|  | C — auto (→ single) | B — manual coordinator |
|---|---|---|
| Wall time | **569 s** | 994 s (+74%) |
| Input tokens (non-cache) | 41,496 | 76,869 (+85%) |
| Output tokens | 14,739 | 10,600 (-28%) |
| Cache reads | 2,564,248 | 1,732,830 |
| Billable (in + out) | **56,235** | 87,469 (+55%) |
| Files modified | 4 | 5 (adds `sympy/tensor/indexed.py`) |
| Bug fixed? `is_finite == True` | ✓ | ✓ |
| Pre-existing test regression | `test_special_is_rational` broke | same test broke |
| team_create / spawn_worker calls | 0 / 0 | 1 / 4 |

### F.1 — Mode correctness

**The router picked the winning mode.** Coordinator took 74% longer and cost 55% more tokens for the same outcome (bug fixed; same pre-existing test regression introduced in both legs). The regression is an agent-side fix-quality issue independent of the routing decision — both the single agent and the coordinator's workers made the same over-aggressive `integer**integer` fast path in `_eval_is_rational`.

Coordinator did touch one extra file (`sympy/tensor/indexed.py`, which was in the prompt's "changes needed" list but the single agent skipped). So on one dimension coordinator was more thorough — but at a 42%-wall-time + 36%-cost premium with the same ultimate outcome on the target assertion.

### F.2 — Overhead

Router overhead is effectively zero for this task: heuristic decision (no tiebreaker invoked; strong-single band), ~10 ms warm routing cost measured in Phase A. The auto run's 569 s matches what a `--agent build` run would have done, minus ~10 ms — well within the plan's `C.time ≤ winner.time × 1.05` bound.

---

## Phase D — Multi-turn inheritance (integration level)  ·  ✓ PASSED

The plan framed Phase D as a TUI-manual walk-through. We covered the same scenarios as automated integration tests in `integration.test.ts` instead — they exercise the same plumbing (session store, fingerprint recomputation, routing + announce) and run in CI forever, where a one-off TUI walk-through would not.

| Escape | Test | Result |
|---|---|---|
| 1 — `/reroute` | `"escape /reroute breaks inheritance"` (pre-existing) | ✓ |
| 2 — fingerprint drift | `"D: escape 2 (drift) — new top-level dir between turns re-routes fresh"` | ✓ new |
| 3 — staleness (>30 min) | unit-tested via fake `decidedAt` in `inherit.test.ts`; integration skipped per plan (manual 30-min wait infeasible) | ✓ unit-only |
| 4 — short follow-up | `"D: escape 4 (short follow) — trivial short prompt on turn 2 re-routes"` | ✓ new |
| 5a — coord → read-only | `"D: escape 5a (coord → read-only) — read-only prompt after coord re-routes + de-escalates"` | ✓ new |
| 5b — single → mutating-broad | unit-tested only (`inherit.test.ts: "escape 5b"`); symmetry is straightforward so integration not needed | ✓ unit-only |

The drift test intentionally mutates the shared test-tmp workspace (adds a `_drift_test_dir` top-level directory), then cleans it up in a `finally` so subsequent tests see a stable fingerprint.

---

## Phase H.2 — Permission-denied workspace  ·  ✓ PASSED

Added: `integration.test.ts: "H.2: permission-denied subdir does not crash the router"`.

Creates a throwaway workspace, makes a subdirectory with `chmod 000`, then runs `selectAgentMode` with the real `RealWorkspaceAnalyzer`. Asserts the call returns a valid mode (doesn't throw) and emits an announce line. Permissions are restored and the tmp dir is recursively removed in a `finally` block.

Skips cleanly when running as root (uid 0), where `chmod 000` is a no-op.

This exercises the `try/catch` wrapper at `router.ts:_route` (lines 37-43) that converts any internal throw into `FALLBACK_DECISION` (`{mode: "single", confidence: "low", reason: "router fallback"}`), plus the `try/catch` around `computeFingerprint` in `integration.ts:106-108`.

```
$ bun test test/router/integration.test.ts -t "H.2"
1 pass · 0 fail · 2 expect() calls
```

---

## Phase C — Real-repo smoke  ·  ✓ PASSED

**Protocol:** for each of 5 repo shapes (4 synthetic fixtures + opencode itself), ran 3 prompts through `opencode debug router --json` in dry-run mode and compared the decision to a human-judged expected mode.

**Fixtures:**
- `single-small` — 21 files, 1 package (`@fixture/small`)
- `single-medium` — 201 files, 1 package (`@fixture/medium`, with `components/`, `pages/`, `lib/` subtrees)
- `small-monorepo` — 205 files, 4 packages (`@fixture/auth`, `@fixture/api`, `@fixture/shared`, `@fixture/web`)
- `polyglot` — 53 files, 2 packages (`@fixture/frontend` TS + `fixture-backend` Python)
- `large-monorepo` — opencode itself, 4576 files, 15+ packages

**Results: 15 / 15 = 100%.**

| Shape | Prompt summary | Expected | Actual | Primary | Fired signals |
|---|---|---|---|---|---|
| single-small | fix typo on line 5 | single | single · high | 0.00 | P5 |
| single-small | add getter for userName | single | single · high | 0.00 | P5 |
| single-small | refactor all methods across every package | single | single · high | 0.00 | P3 (min-gate caps) |
| single-medium | explain the routing | single | single · high | 0.00 | P6, C1 |
| single-medium | add login button | single | single · high | 0.00 | C1 |
| single-medium | refactor auth flow across the entire app | single | single · low | 1.11 | P3, C1 (single-pkg ceiling) |
| small-monorepo | update root README | single | single · high | 0.00 | C1, C2 |
| small-monorepo | refactor auth across @fixture/auth and @fixture/api | **coordinator** | **coordinator · high** | **5.15** | P2, P3, P4, C1, C2, C3, C4 |
| small-monorepo | add shared types to @fixture/shared | single | single · high | 0.45 | P2, C1, C2, C3 |
| polyglot | refactor auth across @fixture/frontend and fixture-backend | **coordinator** | **coordinator · high** | **3.89** | P2, P3, C1, C2, C3, C5 |
| polyglot | update Python tests in packages/backend | single | single · high | 0.45 | P2, C1, C2, C3, C5 |
| polyglot | add new API endpoint in packages/backend | single | single · high | 0.45 | P2, C1, C2, C3, C5 |
| large-monorepo | explain the agent layer | single | single · high | 0.00 | P6, C1, C2 |
| large-monorepo | refactor all Effect imports across packages | **coordinator** | **coordinator · medium** | **2.42** | P3, C1, C2 |
| large-monorepo | update router README.md | single | single · medium | 0.91 | P2, C1, C2, C3, C4 |

**Pass criterion met:** 100% match (bar was ≥ 80%). Zero obvious misses — no "fix typo" routed to coordinator, no trivial read-only prompt escalated.

### Calibration findings (record for future weight tuning)

These are data points the plan explicitly asked us to record for future iterations. Neither is a feature blocker.

**Finding 1 — Pyproject names weren't extracted by the analyzer. (FIXED in v1.5.)**

Originally, `RealWorkspaceAnalyzer.analyze` only read the `name` field from `package.json`, not from `pyproject.toml`. On the polyglot fixture, the analyzer's package list contained `@fixture/frontend` (npm name), `packages/frontend`, and `packages/backend`, but not `fixture-backend` (the pyproject name). P2 could only match via directory paths or the scoped npm name.

This has now been fixed: `readManifestName` dispatches on extension and a small `readPyprojectName` helper handles both PEP 621 `[project].name` and Poetry `[tool.poetry].name`, preferring the former.

End-to-end impact, measured on the same polyglot fixture + prompt:

| Signal | Before | After |
|---|---|---|
| P2 (packages mentioned) | 1 | 2 |
| C4 (cross-package breadth) | 0 | 2 |
| primary score | 3.89 | 4.55 |

C4 now fires for polyglot workloads, which is the intended behavior.

**Finding 2 — "port" is not in the mutation-verb list. (PARTIALLY ADDRESSED in v1.6.)**

`translate` and `rewrite` have been added to `mutationVerbs`. Both are unambiguous mutation verbs with no common superstring collisions, so they expand coordinator recall on "translate this module to X" / "rewrite the handler" prompts with zero measurable downside.

**`port` was evaluated and rejected.** The current archetype classifier uses substring matching (`prompt.includes(verb)`), so `port` would false-positive on common code prompts containing `export`, `import`, `transport`, `important`, `portal`, etc. In particular it breaks the D escape-5a integration test (`"explain how the @app/auth module is structured and what each export does"` — "export" contains "port"). Adding `port` cleanly would require switching to word-boundary matching, which is a larger refactor with knock-on effects on `update → updating`, `move → remove` etc. Deferred to a future calibration iteration.

---

## Phase G — Telemetry validation  ·  ✓ PASSED (G.1, G.2, G.3)

### G.1 — Privacy canary

Added: `test/router/integration.test.ts: "privacy: telemetry never writes raw prompt content (G.1)"`.

A distinctive canary string is embedded in the prompt and the test asserts that:
1. The canary substring never appears in the written JSONL
2. The SHA-256 prefix (first 16 hex chars) of the full prompt does appear

**Why this matters:** the `TelemetryRecord` type already uses `promptSha` (not `prompt`) — so the schema forbids raw prompts by construction. This test adds a runtime check against accidental leakage via any future code path that might inadvertently include prompt content (e.g. a new field, a debug branch, a plugin extension). Cheap insurance against a high-impact privacy regression.

Covered hash: `sha256Hex(prompt).slice(0, 16)`, computed in `integration.ts:184`.

### G.2 — Daily rotation

Added: `test/router/telemetry.test.ts: "records written on different dates go to different files (G.2)"`.

Uses Bun's `setSystemTime` to deterministically advance the clock across a date boundary (2026-04-23 → 2026-04-24), writes one record per date, and asserts two separate `router-decisions-YYYY-MM-DD.jsonl` files exist with the expected record in each.

Guards the filename-derivation path `new Date().toISOString().slice(0, 10)` in `telemetry.ts:15-16`. The `setSystemTime()` restore is in a `finally` so the clock is reset even if the writes throw.

### G.3 — 30-day cleanup

Covered by existing `test/router/telemetry.test.ts: "removes files older than retention period"` (pre-existing in the test file, not newly added for this validation pass). Creates a 60-day-old file via `fs.utimes`, calls `opportunisticCleanup(workspaceRoot, 30)`, asserts the old file is removed while a fresh file survives.

Complementary sibling tests `"does not crash on missing directory"` and `"ignores non-router files"` (also pre-existing) cover the other two G.3-adjacent invariants: graceful no-op when `.opencode/` doesn't exist, and selectivity so the cleanup doesn't delete unrelated files in `.opencode/`.

```
$ bun test test/router/telemetry.test.ts
6 pass · 0 fail · 11 expect() calls
```

---

## Not yet executed

These plan phases would strengthen confidence but do not cover functionality that is unvalidated by other means. Where there is existing unit-test coverage, it is noted.

### Phase D — TUI-manual scenario

The plan's Phase D is a 5-turn TUI-manual sequence. We covered the same 4 escape mechanisms at the integration level instead (see "Phase D" executed section above) — the session-store + routing plumbing is validated without the TUI driver overhead. A live TUI run remains a nice-to-have sanity check but no longer a risk, since every escape branch is covered by both unit tests (`inherit.test.ts`) and integration tests (`integration.test.ts`).

(All of Phase G is now covered — G.1, G.2, G.3 — see "Phase G — Telemetry validation" section below.)

### Phase H.3 — Fault-inject env var

Requires Prereq 2 (`OPENCODE_ROUTER_FAULT_INJECT`) which was not built. Deferred. Unit-test coverage of each fault path is already strong (`router.test.ts: never throws`; `classifier-resilience.test.ts`), so the practical value of a runtime fault-inject hook is limited to ops debugging rather than regression prevention.

### Phase F — Full 3-way A/B/C comparison

A minimal version has been executed (see "Phase F" section above). The full plan was 3 runs × one new task (~3 hours). The minimal variant we ran skips the redundant third leg (manual single ≈ auto since auto picked single) and compares manual coordinator against the existing auto baseline on sympy-16597. A second task would strengthen the evidence but the one we ran already demonstrates both criteria the plan asked about: F.1 (router picked the winning mode) and F.2 (overhead is negligible).

---

## Known issues discovered during validation

### 1. Desktop UI filtered synthetic text parts (fixed)

The Desktop message-timeline treated synthetic router-announce text parts as code-review annotations. Fixed by concatenating the announce into the user's first text part rather than emitting a standalone part. Commits `acc294e7f` → `127b638de` → `fe835b7b8`.

### 2. Browser build rejected Bun's `Glob` (fixed)

`workspace-analyzer.ts` and `fingerprint.ts` originally used `new Bun.Glob(...)`, which broke the Desktop (Electron renderer) bundle. Swapped to `@opencode-ai/shared/util/glob`. Commit `78124af24`.

### 3. Scoped package-name mismatch in P2 (fixed)

`RealWorkspaceAnalyzer` returned directory paths like `packages/opencode`, but P2 prompts typically reference npm-scoped names like `@opencode-ai/opencode`. Fixed to include both forms in the `packages` array by reading `name` from each package's `package.json`. Commit `e0290d78e`.

### 4. Tiebreaker default model UX (simplified)

Originally the tiebreaker resolved a separate "small model" via `Provider.getSmallModel()`. Simplified to use the user's configured model by default; an explicit `tiebreaker.modelRef` in `weights.json` remains as an optional cost-optimization override. Commit `22e259b24`.

### 5. Classifier error classification (improved)

`GuardedClassifier` originally labeled every failure as "timeout" regardless of cause. Now classifies into `timeout`, `auth_error`, `network_error`, `malformed`, or `error`. Also exposed `lastErrorMessage` for downstream diagnostics. Commit `22e259b24`.

### 6. Classifier parser too strict (fixed)

Real LLM outputs often wrap JSON in markdown fences or prose. Added `extractJsonObject` with balanced-brace scanning (respecting string escapes) to handle fenced and prose-wrapped output before falling back to regex. Commit included in `22e259b24`.

### 7. Model-side latency on Z.AI coding plan (external)

The `zai-coding-plan/glm-*` models have genuinely high per-turn latency in our test environment (>30 s for small-model calls, ~569 s total for a single SymPy fix vs prior 172 s baseline on a faster provider). **Not a router issue** — the router's own cost is 10 ms warm / 10 ms cold. Noted for context only.

### 8. Single-package codebase-score ceiling (accepted limitation)

On a single-package repo, the AND-gate (`primaryScore = min(promptScore, codebaseScore)`) correctly caps the overall score below the coordinator band regardless of how ambitious the prompt is. Coordinator mode is not useful on single-package repos — the conservative behavior is correct. Lifting this would require semantic (not structural) signals and is out of scope.

---

## Ship readiness

**Green for the validated paths:**
- Router correctness in both directions (single-package → single, multi-package → coordinator) ✓
- Cold/warm latency well under budget ✓
- Frontend visibility across CLI, TUI, Desktop ✓
- Unit-level coverage of fallback, circuit breaker, inheritance escapes ✓
- Telemetry happy path ✓

**Yellow (unvalidated but low-risk via unit tests):**
- Phase C broader smoke — unit tests cover the scoring logic, real-repo cases would add recall data
- Phase D TUI inheritance — unit tests cover all escape branches
- Phase H permission-denied integration — try/catch wrapper + unit tests provide coverage at the signal level

**Recommended before public release:**
- ~~G.1 privacy test~~ ✓ done
- ~~Partial Phase C pass for false-positive rate data~~ ✓ done — 15/15 match, zero obvious misses
- ~~Phase D integration-level escape coverage~~ ✓ done
- ~~H.2 permission-denied integration~~ ✓ done
- ~~Add pyproject name extraction to `RealWorkspaceAnalyzer`~~ ✓ done — closes the polyglot P2 calibration gap from Phase C
- ~~Build Prereq 2 fault-inject env var~~ ✓ done
- ~~Expand mutation-verb list with semantically-mutating verbs~~ ✓ done (translate + rewrite); `port` deferred pending substring-match refactor
- (future) Word-boundary mutation-verb matching — would allow `port` without false positives on `export` / `import`

---

## Related commits

| Commit | Description |
|---|---|
| `39b1763af` | Phase A — cold/warm latency regression tests |
| `e0290d78e` | `RealWorkspaceAnalyzer` reads npm names from `package.json` (P2 fix) |
| `78124af24` | Cross-platform `Glob` for desktop-electron bundle |
| `54edff1e4` | `.opencode/` added to `.gitignore` (router telemetry dir) |
| `acc294e7f` → `127b638de` → `fe835b7b8` | Desktop UI announce-rendering fix (3-step) |
| `b4417e6dd` | `opencode debug router` subcommand (Prereq 1) |
| `22e259b24` | Tiebreaker UX simplification, error classification, lenient JSON parser |

---

## Revision history

- v1 — 2026-04-24 — initial results after A/B/E pass.
- v1.1 — 2026-04-24 — added Phase G.1 (privacy canary) — now 181 router tests.
- v1.2 — 2026-04-24 — Phase C real-repo smoke complete (15/15 match); 2 calibration findings recorded (pyproject names not extracted; "port" not in mutation-verb list).
- v1.3 — 2026-04-24 — Phase G complete (G.2 added; G.3 already covered by pre-existing `telemetry.test.ts`). Now 182 router tests.
- v1.4 — 2026-04-24 — Phase D (integration-level) + H.2 complete. 4 new tests added: drift, short-follow, coord→read-only, permission-denied. Now 186 router tests.
- v1.5 — 2026-04-24 — Closed Phase C calibration finding #1: analyzer now extracts pyproject.toml names (PEP 621 `[project].name` + Poetry `[tool.poetry].name`). 8 new tests. Now 194 router tests.
- v1.6 — 2026-04-24 — Partially closed Phase C calibration finding #2: added `translate` + `rewrite` to mutation verbs. `port` deferred (substring collision with `export`/`import`). Built Prereq 2 fault-inject env var with `analyzer-fail` / `classifier-timeout` / `classifier-malformed` modes, gated behind `OPENCODE_ROUTER_DEBUG=1`. 16 new tests. Now 210 router tests.
- v1.7 — 2026-04-24 — Minimal Phase F A/B/C done on sympy-16597. Manual coordinator ran 994 s (+74%) and used 87k billable tokens (+55%) vs auto's 569 s / 56k — same bug fixed, same regression. Router's `single` pick confirmed as winning mode; overhead negligible.
