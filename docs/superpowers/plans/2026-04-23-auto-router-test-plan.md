# Auto-Router Test Plan (v2 — revised after critical review)

**Status:** Plan v2 — supersedes v1. The prior plan had blockers (`--route-explain` didn't exist), unreachable tests (fault injection without hooks), and inconsistent latency thresholds. This version fixes those.

**Feature under test:** `packages/opencode/src/agent/router/` — auto-routing between single-agent and coordinator modes. See `packages/opencode/src/agent/router/README.md` for the feature overview.

**Total effort if done in full:** ~6–8 hours across all phases. Minimum viable subset (Phases A, B, C): ~1.5 hours.

---

## Overall success criteria

1. **Correctness**: the router picks the right mode for ≥80% of the real-repo smoke-test prompts (mode matches a human's judgment).
2. **No regressions**: all 170+ router unit tests pass, full opencode suite (2224 tests) has no new failures, typecheck green across all 13 packages.
3. **Overhead**: cold router decision (first call in a repo) < 1.5 s p95; warm calls < 10 ms; tiebreaker LLM call never exceeds its 3 s timeout.
4. **Frontend coverage**: feature works in CLI, TUI, and Desktop — verified by manual smoke test on each.
5. **Safety nets**: permission-denied workspace doesn't crash; other failure modes covered by unit tests.
6. **Observability**: every decision produces a telemetry record with the expected fields.

---

## Prerequisites (must do before Phase C onwards)

### Prereq 1: Build `--route-explain` CLI flag

**Why:** Phase C (real-repo smoke) becomes prohibitively slow without a dry-run inspector. Also provides end-user value as a debugging tool.

**What:** Add a flag to `packages/opencode/src/cli/cmd/run.ts` that, when passed, runs the full router pipeline for the given prompt and prints the decision, fired signals, scores, and whether the tiebreaker would fire — **without actually running the agent**.

**Example output:**
```
$ opencode --route-explain "refactor all auth handlers across @app/auth and @app/api"

Routing decision: coordinator (high confidence)
Reason: 5 packages, 500 files
Fired signals:
  P2_package_mentions  (2 of 4 max)
  P3_scope_keywords    (2 of 3 max — "all" + "across" with mutation verb "refactor")
  C2_package_count     (banded: 1)
  C3_affected_subset   (banded: 3)
  C4_cross_package     (2)
Task archetype: mutating-broad
Scores:
  promptScore    = 3.33
  codebaseScore  = 6.67
  primaryScore   = 3.33  (min-gate)
Band: [3.0, 10] → coordinator, high confidence
Tiebreaker: not invoked (primary ≥ uncertain-band max)
Workspace fingerprint: wf_a1b2c3d4
```

Flag variants:
- `--route-explain` — heuristic-only (dry-run, never invokes the LLM tiebreaker even for uncertain band; labels uncertain output as "would invoke tiebreaker")
- `--route-explain=full` — actually invokes the tiebreaker if in uncertain band (one real LLM call); shows its verdict and latency

**Effort:** ~45 min.

**Acceptance:** Unit test covers both modes; manual test produces readable output on 3 different prompts.

### Prereq 2: Optional fault-injection env var

**Why:** Makes Phase H (safety nets) partially reachable in integration — today, fault injection is only possible at the unit-test level.

**What:** Add an environment variable `OPENCODE_ROUTER_FAULT_INJECT` honored in the wiring layer (`build-classifier.ts`, `wire.ts`):

| Value | Effect |
|---|---|
| `analyzer-fail` | `RealWorkspaceAnalyzer.analyze` always throws |
| `classifier-timeout` | Classifier never resolves (exercises timeout path) |
| `classifier-malformed` | Classifier returns garbage text (exercises parse-error path) |

Intentionally only active when `OPENCODE_ROUTER_DEBUG=1` is also set, to prevent accidental production activation.

**Effort:** ~30 min.

**Acceptance:** Setting the env var causes the expected fallback on a real run; not setting it has zero effect.

---

## Phase A — Regression & micro-benchmarks (CI, automated)

**Goal:** No regressions, and the router's own cost is measured and bounded.

**Effort:** ~10 min to add, runs forever in CI.

### A.1 — Existing test suite (no changes)

```bash
cd packages/opencode && bun test --timeout 30000
```

**Pass criterion:** 2224+ pass, same 1 pre-existing plugin failure unrelated to router. 170+ router tests pass.

### A.2 — Router latency: warm path (heuristic-only, cached analyzer)

New test file: `packages/opencode/test/router/latency.test.ts`

```typescript
import { FakeWorkspaceAnalyzer } from "@/agent/router/workspace-analyzer"
import { route } from "@/agent/router"

test("warm route() < 10ms p95 across 100 calls", async () => {
  const analyzer = new FakeWorkspaceAnalyzer({ totalFiles: 500, packageCount: 5, ... })
  const samples: number[] = []
  for (let i = 0; i < 100; i++) {
    const start = performance.now()
    await route({ prompt: "refactor all auth...", analyzer, ... })
    samples.push(performance.now() - start)
  }
  samples.sort((a, b) => a - b)
  expect(samples[Math.floor(samples.length * 0.95)]).toBeLessThan(10)
})
```

### A.3 — Router latency: cold path (real analyzer, first call)

```typescript
test("cold route() with RealWorkspaceAnalyzer < 1500ms p95 on ≤1000-file repo", async () => {
  // Use the existing monorepo-small fixture (≈15 files, representative of a small real repo)
  const samples: number[] = []
  for (let i = 0; i < 20; i++) {
    const analyzer = new RealWorkspaceAnalyzer()  // fresh instance = cold
    const start = performance.now()
    await route({ prompt: "refactor all auth", workspaceRoot: FIXTURES.monorepoSmall, analyzer, ... })
    samples.push(performance.now() - start)
  }
  samples.sort((a, b) => a - b)
  expect(samples[Math.floor(samples.length * 0.95)]).toBeLessThan(1500)
})
```

**Pass criterion:** Both tests pass in CI.

---

## Phase B — Frontend UX validation (manual, ~20 min)

**Goal:** Confirm the feature is visible and usable in CLI, TUI, and Desktop.

**Effort:** ~20 min total.

### B.1 — CLI

```bash
# No flag → router fires
opencode "fix the typo on line 5 in utils.ts"
# Expected: "→ Routing: single · ..." appears before agent output

# --agent auto → router fires
opencode --agent auto "refactor all auth handlers"
# Expected: announce line appears

# --agent build → router bypassed
opencode --agent build "refactor all auth handlers"
# Expected: no "→ Routing:" line (router skipped)

# --route-explain → dry-run (requires Prereq 1)
opencode --route-explain "refactor all auth across @app/auth and @app/api"
# Expected: structured decision output, no agent run
```

### B.2 — TUI

```bash
opencode tui
```

Then in the TUI:
1. Open agent picker (whatever key binding opens the agent dialog).
   - **Expected**: "auto" appears at the top of the list with description "Auto-route based on task complexity (default)".
2. With "auto" selected (default), type a prompt and send.
   - **Expected**: a toast notification appears with the routing decision before the agent starts.
3. Switch to "build" via the picker, send another prompt.
   - **Expected**: no routing toast (router bypassed).

### B.3 — Desktop

```bash
# From monorepo root
bun --filter @opencode-ai/desktop-electron run dev  # or whatever the dev script is
```

1. Launch desktop app, open a workspace.
2. **Expected**: Agent picker in the app sidebar shows "auto" at the top.
3. Send a prompt with "auto" selected — confirm routing toast or notification appears.
4. Switch to another agent, send another prompt — confirm router bypassed.

**Pass criterion for Phase B:** All three frontends show "auto", announce routing decisions, and allow manual bypass.

---

## Phase C — Real-repo smoke test (uses `--route-explain`)

**Goal:** Confirm the router makes sensible decisions on real repos. No agent runs — dry-run only.

**Prerequisite:** `--route-explain` flag (Prereq 1).

**Effort:** ~30 min for 5 repos × 4–5 prompts each.

### Protocol

For each repo:

1. `cd <repo>` and record its shape: file count, package count, language count.
2. **Customize the prompts** to use the repo's actual top-level package names (don't use `@app/auth` if the repo uses `@acme/auth`).
3. For each prompt, run `opencode --route-explain "<prompt>"` and record:
   - Routing decision (single / coordinator / uncertain)
   - Fired signals
   - Primary score
4. Compare against a human judgment of what the decision *should* be.

### Repo × prompt matrix

| Repo shape | Example | Prompts to test | Expected decisions |
|---|---|---|---|
| **Single-package small** (20 files, 1 pkg) | a utility library | (a) "fix typo on line 5" (b) "add a getter for X" (c) "refactor all methods across every package" | a→single, b→single, c→single (min-gate) |
| **Single-package medium** (200 files, 1 pkg) | a Next.js app | (a) "explain the routing" (b) "add login button" (c) "refactor auth flow across the app" | a→single (read-only), b→single, c→single (min-gate, 1 pkg) |
| **Small monorepo** (200 files, 4 pkgs) | a workspace repo | (a) "update the root README" (b) "refactor auth handlers across @<real>/auth and @<real>/api" (c) "add shared types to @<real>/shared" | a→single, b→coordinator, c→single |
| **Large monorepo** (opencode itself — ~3000 files, 19 pkgs) | this repo | (a) "explain the agent layer" (b) "refactor all Effect imports across packages" (c) "update packages/opencode/src/agent/router/README.md" | a→single (read-only), b→coordinator or uncertain, c→single (specific file) |
| **Polyglot** (TS + Python, 2 pkgs) | frontend+backend | (a) "port auth from Python to TS" (b) "update Python tests" (c) "add API endpoint" | a→coordinator or uncertain, b→single, c→single |

### Pass criterion

- ≥80% of decisions match the human-expected mode (14/17 prompts).
- Zero "obvious misses" — e.g. "fix typo" must never route to coordinator (false positive is the expensive failure mode).

### Record findings

For any disagreement, log:
- Prompt, repo, expected, actual, fired signals, primary score.

These become data points for future weight tuning.

---

## Phase D — Multi-turn inheritance (TUI only, manual)

**Goal:** Verify inheritance + 4 of the 5 escape conditions at the live integration level.

**Effort:** ~15 min.

**Notes:**
- Run in TUI (natural multi-turn frontend — CLI is one-shot).
- Staleness escape (30-min timer) is skipped — covered by unit tests with fake clock.

### Protocol

Open a TUI session on the opencode monorepo. Execute sequentially:

| Turn | Prompt | Expected behavior |
|---|---|---|
| 1 | "refactor all router tests across packages/opencode" | Toast: `→ Routing: coordinator · ...` |
| 2 | "now also update the README in each package" | Toast: `→ Routing: coordinator · inherited from previous turn` |
| 3 | "explain what you did in the last two turns" | Toast: `→ Routing: single · read-only task` (escape 5a: coordinator→read-only flip) |
| 4 | "/reroute fix the typo on line 5 of utils.ts" | Toast: `→ Routing: single · ...` (escape 1: `/reroute`) |
| 5 | **After this**: open a new terminal, create `extra-pkg/package.json` in the monorepo. Then in TUI: "add tests across @extra-pkg and @existing-pkg" | Toast should include `inherited from previous turn` **initially stops**, because fingerprint changed → escape 2 (drift) fires → fresh routing |

### Pass criterion

- Turn 2 inherits (no re-routing).
- Turns 3, 4, 5 all show re-routing (not inherited) with the expected escape reason.

---

## Phase E — SWE-bench replication (2 cases, semi-automated)

**Goal:** Validate that the router would have made the right choice on real bug-fix tasks.

**Prerequisite:** Local SymPy clone at the pre-fix commit for each task (may need to reconstruct from `MULTI_AGENT_README.md`'s prior setup).

**Effort:** ~30 min setup + 30–60 min per case = ~2 hours total.

### Phase E.1 — Dry-run validation first (cheap, ~10 min)

Before any full runs, use `--route-explain` to predict what the router will pick:

```bash
cd ~/swebench-workspaces/sympy-16597  # reproduced from prior work
opencode --route-explain "<bug description from SWE-bench task spec>"
```

Do this for both cases. Record predictions.

### Phase E.2 — Full runs (expensive, ~1–2 hours)

For each case, run **only the mode the router predicted** (not A/B/C — that's Phase F). Compare result + timing against the prior case-study data in `MULTI_AGENT_README.md`.

| Case | Task | Router-predicted mode | Prior winner | Expected |
|---|---|---|---|---|
| **E.2.a** — SymPy `is_finite` | `sympy__sympy-16597` — 6 files, 4 subsystems | (fill from E.1) | Single (172s beat multi-agent's 213s) | Router should predict single; if so, run time should match prior single run. |
| **E.2.b** — SymPy rich comparison | `sympy__sympy-13091` — 21 files, 6 modules | (fill from E.1) | Coordinator (single failed, coordinator resolved) | Router should predict coordinator; if so, run should resolve correctly. |

### Pass criterion

- For both cases: router's predicted mode is the *winning* mode per prior data (single for E.2.a, coordinator for E.2.b).
- Actual run with predicted mode produces the correct outcome (tests pass).

### Failure-mode handling

- If router predicts the *losing* mode, that's a data point for weight tuning. Don't abandon the feature — document which signals misled the router.

---

## Phase F — A/B/C comparison (one new SWE-bench task, full cost)

**Goal:** Hard evidence that "auto" is at least as good as picking either mode manually, on a task not in the calibration set.

**Prerequisite:** One SWE-bench Verified task with a known reference solution.

**Effort:** ~3 hours (three full end-to-end runs).

### Protocol

1. Pick one new task from SWE-bench Verified (not the two from Phase E).
2. Extract the user-facing bug description as the prompt.
3. Run three times on three fresh worktrees:
   - **A** — `opencode --agent build "<prompt>"` (always single)
   - **B** — `opencode --agent coordinator "<prompt>"` (always multi-agent)
   - **C** — `opencode --agent auto "<prompt>"` (router decides)
4. Record for each: wall time, total tokens, test results, and for (C): the router's announced mode + whether the tiebreaker fired.

### Pass criterion — two-part, explicit

**F.1 — Mode correctness**: Did (C) pick the mode that won between (A) and (B)?
- Pass: (C) picks the faster-correct winner
- Conditional pass: (C) picks the losing mode but still solves the task (cost is worse but outcome is right)
- Fail: (C) picks a mode that doesn't solve the task when the other would have

**F.2 — Overhead**: When (C)'s mode matches the winner:
- (C).time ≤ (winner).time × 1.05 (within 5% of the manual choice)
- (C).cost ≤ (winner).cost + ~$0.001 (one small-model tiebreaker call at most)

**If F.1 fails:** the router has a calibration gap. Record and add to the prompt fixture for future tuning. Not a feature blocker if F.2 and overall correctness are fine.

---

## Phase G — Telemetry validation (automated, ~15 min)

**Goal:** Confirm the telemetry writer produces the expected records.

Existing integration test `integration.test.ts:"telemetry record is written when suppressTelemetry is false"` already covers the happy path. Add three more:

### G.1 — Privacy check

```typescript
test("telemetry never writes raw prompts", async () => {
  const testPrompt = "SECRET_CANARY_STRING_must_not_appear_in_telemetry"
  await selectAgentMode({ prompt: testPrompt, ... suppressTelemetry: false })
  const content = await fs.readFile(todaysFile, "utf-8")
  expect(content).not.toContain(testPrompt)
  // but it SHOULD contain the hash
  const expectedSha = createHash("sha256").update(testPrompt).digest("hex").slice(0, 16)
  expect(content).toContain(expectedSha)
})
```

### G.2 — Daily rotation

```typescript
test("records written on different dates go to different files", async () => {
  // Mock Date.now() to "2026-04-23" for first write
  // Mock Date.now() to "2026-04-24" for second write
  // Expect two separate files
})
```

### G.3 — 30-day cleanup

```typescript
test("opportunisticCleanup unlinks files older than 30 days", async () => {
  // Create 3 files: one 10 days old, one 31 days old, one 60 days old
  // Run opportunisticCleanup
  // Expect only the 10-day-old survives
})
```

### Pass criterion

All three tests pass in CI.

---

## Phase H — Safety-net validation (covered by unit tests; 1 manual check)

**Goal:** Confirm safety nets work. Most are already unit-tested — this phase cites those and adds one integration check.

### H.1 — Already covered (citation only — no new work)

| Safety net | Unit test | Status |
|---|---|---|
| Router never throws (internal error → single/low fallback) | `router.test.ts:"never throws — returns single on internal error"` | ✅ |
| Circuit breaker trips after 5 consecutive failures | `classifier-resilience.test.ts:"circuit breaker: trips after N consecutive failures"` | ✅ |
| Circuit breaker half-open recovery | `classifier-resilience.test.ts:"circuit recovery: after cooldown, failure counter resets (half-open)"` | ✅ |
| Rate limiter (20 calls max) | `classifier-resilience.test.ts:"rate limit: returns null after maxCallsPerSession"` | ✅ |
| Error-budget banner at 4/20 | `integration.test.ts:"error budget banner fires after multiple fallbacks"` | ✅ |
| Conservative default (low-confidence → single) | `router.test.ts` band tests + `classifier.test.ts` mapping tests | ✅ |

### H.2 — Permission-denied workspace (manual, integration-level)

The one failure mode that's *only* reachable with a real filesystem:

```bash
# Create a workspace with an unreadable subdirectory
mkdir /tmp/test-perm-ws && cd /tmp/test-perm-ws
echo '{}' > package.json
mkdir subdir && chmod 000 subdir

# Run opencode from here
opencode --agent auto "fix something"

# Expected: routing decision is announced (probably "single, low" with fallbackPath)
# NOT expected: crash, unhandled error, blocked turn
```

### H.3 — With fault-injection env var (if Prereq 2 is built)

```bash
OPENCODE_ROUTER_DEBUG=1 OPENCODE_ROUTER_FAULT_INJECT=analyzer-fail opencode --route-explain "test"
# Expected: falls back to single, prints fallbackPath in debug output
```

### Pass criterion

- H.2 produces a routing announcement and the turn completes (single-agent mode).
- No crashes or unhandled errors.

---

## Deferred (not in this test plan)

1. **Concurrent sessions**: `sessionStore` is a module-level singleton. Multiple TUI windows on the same machine could cross-contaminate state. Documented as a known limitation in the README; not covered here because it requires multi-process test infrastructure.
2. **Long-running sessions across process restarts**: The session store is in-memory. Restarting opencode resets inheritance. This is documented behavior (staleness escape would fire anyway after 30 min), not tested here.
3. **Cross-platform (Windows)**: All tests run on macOS/Linux. Windows path handling in `fingerprint.ts` and `workspace-analyzer.ts` is best-effort.

---

## Execution order & minimum viable subset

| Order | Phase | Time | Required for ship? |
|---|---|---|---|
| 0 | **Prereq 1 — `--route-explain`** | 45 min | Yes (unblocks Phase C) |
| 1 | **Phase A — regression + latency** | 10 min (code) + CI runs forever | Yes |
| 2 | **Phase B — CLI/TUI/Desktop UX** | 20 min manual | Yes |
| 3 | **Phase C — real-repo smoke** | 30 min manual | Yes |
| 4 | **Phase G — telemetry tests** | 15 min to add | Yes |
| 5 | **Phase D — multi-turn inheritance** | 15 min manual | Strongly recommended |
| 6 | **Phase H — permission-denied + fault-inject** | 10 min manual | Strongly recommended |
| 7 | **Prereq 2 — fault-inject env var** | 30 min | Optional (enables fuller Phase H) |
| 8 | **Phase E — SWE-bench replication** | 2 hours | Recommended — validates against prior benchmarks |
| 9 | **Phase F — A/B/C comparison** | 3 hours | Nice to have — hard evidence of win |

**Minimum viable subset (MVS): Prereq 1 + Phases A, B, C, G, D, H = ~2.5 hours**

If any of A/B/C/G/D fails → fix before shipping.
If E or F fails → calibration gap; record for future tuning but not a blocker unless the router actively breaks correctness.

---

## Revision history

- v2 (this doc) — fixed 12 issues identified in self-review: removed unreachable `--route-explain` dependency (now a prereq), split cold/warm latency, split F's mode-correctness vs overhead criteria, removed mislabeled Case 1, dropped staleness manual test, added fault-injection env var, added cold-start / concurrent-session / coordinator-hints gaps, added H.2 permission-denied test.
- v1 — initial draft (superseded).
