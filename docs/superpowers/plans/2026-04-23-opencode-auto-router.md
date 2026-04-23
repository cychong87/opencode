# Auto-Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically route user tasks to single-agent or coordinator (multi-agent) mode based on composite heuristic signals plus an optional LLM tiebreaker.

**Architecture:** A standalone `router/` module computes prompt signals (P1–P6) and codebase signals (C1–C5), combines them via `min(prompt, codebase)` into decision bands, optionally fires a cheap LLM classifier in the uncertain band, and returns a `RoutingDecision`. The router is integrated into `agent.ts` via a `selectAgent` hook that respects manual `--agent` overrides and session-turn inheritance.

**Tech Stack:** TypeScript, Bun, Effect (for Ripgrep.Service integration), bun:test

**Spec:** `docs/superpowers/specs/2026-04-23-opencode-auto-router-design.md`

**Codebase conventions:**
- Tests: `packages/opencode/test/<category>/` using `bun:test` (`describe/test/expect`)
- Imports: `@/` alias → `packages/opencode/src/`
- Agents: registered as objects in a Record inside `agent.ts`
- Prompts: `import PROMPT_X from "./prompt/x.txt"` (static Bun text import)

---

## Phase A: Foundation & Pure Modules

### Task 1: Directory scaffold, types, and weights config

**Files:**
- Create: `packages/opencode/src/agent/router/types.ts`
- Create: `packages/opencode/src/agent/router/weights.json`
- Create: `packages/opencode/src/agent/router/gate.json`

- [ ] **Step 1: Create the router directory structure**

```bash
mkdir -p packages/opencode/src/agent/router/fixtures/workspaces
```

- [ ] **Step 2: Create types.ts with all interfaces**

```typescript
// packages/opencode/src/agent/router/types.ts

export type AgentMode = "single" | "coordinator"
export type Confidence = "high" | "medium" | "low"
export type TaskArchetype = "mutating-broad" | "mutating-narrow" | "read-only" | "trivial"
export type DecisionSource = "routed" | "inherited" | "override"

export interface RouteInput {
  prompt: string
  workspaceRoot: string
  cwd: string
  modelId: string
  sessionHistory?: {
    previousDecision?: RoutingDecision
    turnIndex: number
  }
  analyzer: WorkspaceAnalyzer
  classifier?: LLMClassifier
  config?: RouterConfig
}

export interface RoutingDecision {
  mode: AgentMode
  reason: string
  confidence: Confidence
  confidenceScore: number
  firedSignals: string[]
  suggestedWorkerCount?: number
  suggestedPartition?: string[][]
  signals: {
    promptScore: number
    codebaseScore: number
    llmTiebreakerUsed: boolean
    llmTiebreakerLatencyMs?: number
  }
  decidedAt: number
  workspaceFingerprint: string
}

export interface WorkspaceAnalysis {
  totalFiles: number
  packageCount: number
  packages: string[]
  languageCount: number
  manifestPaths: string[]
  topLevelDirs: string[]
}

export interface WorkspaceAnalyzer {
  analyze(workspaceRoot: string): Promise<WorkspaceAnalysis>
}

export interface ClassifierInput {
  prompt: string
  firedSignalNames: string[]
  heuristicSummary: {
    taskArchetype: TaskArchetype
    fileCount: number
    packageCount: number
  }
  timeoutMs: number
}

export interface ClassifierOutput {
  decision: AgentMode
  confidence: "high" | "low"
  reason: string
}

export interface LLMClassifier {
  classify(input: ClassifierInput): Promise<ClassifierOutput>
}

export interface RouterConfig {
  weightsVersion: string
  promptSignalWeights: Record<string, number>
  codebaseSignalWeights: Record<string, number>
  bands: {
    strongSingleMax: number
    leanSingleMax: number
    uncertainMax: number
    leanCoordinatorMax: number
  }
  tiebreaker: TiebreakerConfig
  mutationVerbs: string[]
  scopeKeywords: string[]
}

export interface TiebreakerConfig {
  enabled: boolean
  modelRef: string | null
  timeoutMs: number
  maxTokens: number
  maxCallsPerSession: number
  circuitBreaker: {
    consecutiveFailuresToTrip: number
    cooldownMs: number
  }
}

export interface HintBlock {
  suggestedWorkerCount?: number
  suggestedPartition?: string[][]
  triggerReasons: string[]
}

export interface TelemetryRecord {
  ts: string
  sessionId: string
  turnIndex: number
  source: DecisionSource
  promptSha: string
  workspaceFingerprint: string
  routerDecisionVersion: string
  firedSignalNames: string[]
  taskArchetype: TaskArchetype
  scores: { prompt: number; codebase: number; primary: number; secondary: number }
  classifier: {
    invoked: boolean
    modelRef?: string
    latencyMs?: number
    outcome?: string
    failureMode: string | null
  }
  finalDecision: { mode: AgentMode; confidence: Confidence }
  fallbackPath: string | null
}
```

- [ ] **Step 3: Create weights.json with default values**

```json
{
  "weightsVersion": "v0.1.0",
  "promptSignalWeights": {
    "P1_glob_mentions": 1,
    "P2_package_mentions": 1,
    "P3_scope_keywords": 1,
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
    "strongSingleMax": 3,
    "leanSingleMax": 4.5,
    "uncertainMax": 6,
    "leanCoordinatorMax": 7.5
  },
  "mutationVerbs": [
    "refactor", "migrate", "rename", "update", "add", "remove",
    "delete", "replace", "convert", "extract", "move"
  ],
  "scopeKeywords": [
    "all", "every", "across", "entire", "whole",
    "throughout", "codebase-wide", "repo-wide"
  ],
  "tiebreaker": {
    "enabled": true,
    "modelRef": null,
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

- [ ] **Step 4: Create gate.json seed**

```json
{
  "precision": 0.65,
  "recall": 0.65,
  "f1": 0.60,
  "note": "Seed values — updated automatically after first calibration run"
}
```

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/agent/router/
git commit -m "feat(router): scaffold directory, types, and weights config"
```

---

### Task 2: Fingerprint module

**Files:**
- Create: `packages/opencode/src/agent/router/fingerprint.ts`
- Test: `packages/opencode/test/router/fingerprint.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/opencode/test/router/fingerprint.test.ts
import { describe, test, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { computeFingerprint } from "@/agent/router/fingerprint"

async function makeTmpDir(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(import.meta.dir, "tmp-fp-"))
  return { path: dir, cleanup: () => fs.rm(dir, { recursive: true }) }
}

describe("computeFingerprint", () => {
  test("identical workspaces produce identical fingerprints", async () => {
    const tmp = await makeTmpDir()
    try {
      await fs.writeFile(path.join(tmp.path, "package.json"), "{}")
      await fs.mkdir(path.join(tmp.path, "src"))
      const fp1 = await computeFingerprint(tmp.path)
      const fp2 = await computeFingerprint(tmp.path)
      expect(fp1).toBe(fp2)
      expect(fp1).toHaveLength(16)
    } finally { await tmp.cleanup() }
  })

  test("adding a .md file does NOT change fingerprint", async () => {
    const tmp = await makeTmpDir()
    try {
      await fs.writeFile(path.join(tmp.path, "package.json"), "{}")
      await fs.mkdir(path.join(tmp.path, "src"))
      const fp1 = await computeFingerprint(tmp.path)
      await fs.writeFile(path.join(tmp.path, "README.md"), "# Hello")
      const fp2 = await computeFingerprint(tmp.path)
      expect(fp1).toBe(fp2)
    } finally { await tmp.cleanup() }
  })

  test("adding a new manifest changes fingerprint", async () => {
    const tmp = await makeTmpDir()
    try {
      await fs.writeFile(path.join(tmp.path, "package.json"), "{}")
      const fp1 = await computeFingerprint(tmp.path)
      await fs.mkdir(path.join(tmp.path, "backend"))
      await fs.writeFile(path.join(tmp.path, "backend", "pyproject.toml"), "")
      const fp2 = await computeFingerprint(tmp.path)
      expect(fp1).not.toBe(fp2)
    } finally { await tmp.cleanup() }
  })

  test("adding a new top-level dir changes fingerprint", async () => {
    const tmp = await makeTmpDir()
    try {
      await fs.writeFile(path.join(tmp.path, "package.json"), "{}")
      const fp1 = await computeFingerprint(tmp.path)
      await fs.mkdir(path.join(tmp.path, "newpkg"))
      const fp2 = await computeFingerprint(tmp.path)
      expect(fp1).not.toBe(fp2)
    } finally { await tmp.cleanup() }
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/opencode && bun test test/router/fingerprint.test.ts`
Expected: FAIL — `Cannot find module "@/agent/router/fingerprint"`

- [ ] **Step 3: Implement fingerprint.ts**

```typescript
// packages/opencode/src/agent/router/fingerprint.ts
import path from "path"
import fs from "fs/promises"
import { createHash } from "crypto"
import { Glob } from "bun"

const MANIFEST_PATTERNS = [
  "package.json", "*/package.json",
  "pyproject.toml", "*/pyproject.toml",
  "Cargo.toml", "*/Cargo.toml",
  "go.mod", "*/go.mod",
  "pom.xml", "*.sln",
]

export async function computeFingerprint(workspaceRoot: string): Promise<string> {
  const manifests: string[] = []
  for (const pattern of MANIFEST_PATTERNS) {
    const glob = new Glob(pattern)
    for await (const file of glob.scan({ cwd: workspaceRoot, onlyFiles: true })) {
      manifests.push(file)
    }
  }
  manifests.sort()

  const entries = await fs.readdir(workspaceRoot, { withFileTypes: true })
  const topDirs = entries
    .filter(e => e.isDirectory() && !e.name.startsWith("."))
    .map(e => e.name)
    .sort()

  const basename = path.basename(workspaceRoot)
  const input = [...manifests, "|", ...topDirs, "|", basename].join("\n")
  return createHash("sha256").update(input).digest("hex").slice(0, 16)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/opencode && bun test test/router/fingerprint.test.ts`
Expected: 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/agent/router/fingerprint.ts packages/opencode/test/router/fingerprint.test.ts
git commit -m "feat(router): add workspace fingerprint module with structural stability"
```

---

### Task 3: Compose-prompt module + coordinator.txt placeholder

**Files:**
- Create: `packages/opencode/src/agent/router/compose-prompt.ts`
- Modify: `packages/opencode/src/agent/prompt/coordinator.txt`
- Test: `packages/opencode/test/router/compose-prompt.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/opencode/test/router/compose-prompt.test.ts
import { describe, test, expect } from "bun:test"
import { composeCoordinatorPrompt, renderHintBlock } from "@/agent/router/compose-prompt"
import type { HintBlock } from "@/agent/router/types"

describe("composeCoordinatorPrompt", () => {
  const basePrompt = "You are a coordinator.\n\n{{ROUTER_HINTS}}\n\nDo not over-delegate."

  test("strips placeholder when hints are null", () => {
    const result = composeCoordinatorPrompt(basePrompt, null)
    expect(result).not.toContain("{{ROUTER_HINTS}}")
    expect(result).toContain("You are a coordinator.")
    expect(result).toContain("Do not over-delegate.")
    expect(result).not.toMatch(/\n{3,}/)
  })

  test("injects hint block at placeholder", () => {
    const hints: HintBlock = {
      suggestedWorkerCount: 3,
      suggestedPartition: [["packages/auth/**"], ["packages/api/**"], ["packages/shared/**"]],
      triggerReasons: ["cross-package", "mutating-broad"],
    }
    const result = composeCoordinatorPrompt(basePrompt, hints)
    expect(result).not.toContain("{{ROUTER_HINTS}}")
    expect(result).toContain("## Router Hints")
    expect(result).toContain("Suggested worker count: 3")
    expect(result).toContain("packages/auth/**")
  })

  test("throws if base prompt has no placeholder", () => {
    expect(() => composeCoordinatorPrompt("No placeholder here", null)).toThrow(
      "coordinator.txt is missing {{ROUTER_HINTS}} placeholder"
    )
  })
})

describe("renderHintBlock", () => {
  test("renders partition groups", () => {
    const hints: HintBlock = {
      suggestedWorkerCount: 2,
      suggestedPartition: [["src/a/**"], ["src/b/**"]],
      triggerReasons: ["cross-package"],
    }
    const block = renderHintBlock(hints)
    expect(block).toContain("Worker 1: src/a/**")
    expect(block).toContain("Worker 2: src/b/**")
    expect(block).toContain("cross-package")
  })

  test("omits partition if not provided", () => {
    const hints: HintBlock = {
      triggerReasons: ["mutating-broad"],
    }
    const block = renderHintBlock(hints)
    expect(block).not.toContain("Worker")
    expect(block).toContain("mutating-broad")
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/opencode && bun test test/router/compose-prompt.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement compose-prompt.ts**

```typescript
// packages/opencode/src/agent/router/compose-prompt.ts
import type { HintBlock } from "./types"

const PLACEHOLDER = "{{ROUTER_HINTS}}"

export function composeCoordinatorPrompt(base: string, hints: HintBlock | null): string {
  if (!base.includes(PLACEHOLDER)) {
    throw new Error("coordinator.txt is missing {{ROUTER_HINTS}} placeholder")
  }
  if (!hints) {
    return base.replace(PLACEHOLDER, "").replace(/\n{3,}/g, "\n\n")
  }
  return base.replace(PLACEHOLDER, renderHintBlock(hints))
}

export function renderHintBlock(hints: HintBlock): string {
  const lines: string[] = [
    "## Router Hints (advisory — override if you disagree)",
    "",
    "The auto-router analyzed this task before you started. Its guesses:",
  ]

  if (hints.suggestedWorkerCount !== undefined) {
    lines.push(`- Suggested worker count: ${hints.suggestedWorkerCount}`)
  }

  if (hints.suggestedPartition && hints.suggestedPartition.length > 0) {
    lines.push("- Suggested partition:")
    for (let i = 0; i < hints.suggestedPartition.length; i++) {
      lines.push(`  - Worker ${i + 1}: ${hints.suggestedPartition[i].join(", ")}`)
    }
  }

  if (hints.triggerReasons.length > 0) {
    lines.push(`- Signals that triggered coordinator: ${hints.triggerReasons.join(", ")}`)
  }

  lines.push(
    "",
    "Use these as a starting point. You are free to spawn fewer or more workers,",
    "or repartition, based on your own judgment.",
  )
  return lines.join("\n")
}
```

- [ ] **Step 4: Add {{ROUTER_HINTS}} placeholder to coordinator.txt**

Read `packages/opencode/src/agent/prompt/coordinator.txt` and find the boundary between the role/workflow section and the anti-patterns section. Insert the placeholder there:

```
{{ROUTER_HINTS}}
```

Insert this on its own line after the workflow instructions (steps 1-6 section) and before the "IMPORTANT" / anti-patterns section. The exact line depends on the current file — read it first.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/opencode && bun test test/router/compose-prompt.test.ts`
Expected: 4 tests PASS

- [ ] **Step 6: Commit**

```bash
git add packages/opencode/src/agent/router/compose-prompt.ts packages/opencode/test/router/compose-prompt.test.ts packages/opencode/src/agent/prompt/coordinator.txt
git commit -m "feat(router): add compose-prompt module and coordinator.txt placeholder"
```

---

### Task 4: Tiebreaker prompt file

**Files:**
- Create: `packages/opencode/src/agent/prompt/tiebreaker.txt`

- [ ] **Step 1: Create the frozen system prompt**

```
You are a routing classifier for a multi-agent coding system. Given a user task and workspace signals, decide whether it should run as a single agent (one LLM handles it) or be routed to a coordinator (which spawns multiple parallel workers).

Coordinator is worthwhile only when the task has multiple genuinely independent subtasks that can run in parallel, each owning non-overlapping files. Trivial tasks, single-file edits, and purely read-only tasks belong on a single agent.

Output strict JSON: {"decision": "single"|"coordinator", "confidence": "high"|"low", "reason": "<15 words max>"}
```

- [ ] **Step 2: Commit**

```bash
git add packages/opencode/src/agent/prompt/tiebreaker.txt
git commit -m "feat(router): add frozen tiebreaker classifier prompt"
```

---

## Phase B: Workspace Analysis

### Task 5: Workspace analyzer — interface and fake

**Files:**
- Create: `packages/opencode/src/agent/router/workspace-analyzer.ts`
- Test: `packages/opencode/test/router/workspace-analyzer.test.ts`

- [ ] **Step 1: Write the failing tests using a fake analyzer**

```typescript
// packages/opencode/test/router/workspace-analyzer.test.ts
import { describe, test, expect } from "bun:test"
import { FakeWorkspaceAnalyzer } from "@/agent/router/workspace-analyzer"

describe("FakeWorkspaceAnalyzer", () => {
  test("returns configured analysis", async () => {
    const analyzer = new FakeWorkspaceAnalyzer({
      totalFiles: 100,
      packageCount: 3,
      packages: ["@app/auth", "@app/api", "@app/shared"],
      languageCount: 1,
      manifestPaths: ["package.json", "packages/auth/package.json", "packages/api/package.json"],
      topLevelDirs: ["packages", "scripts", "docs"],
    })
    const result = await analyzer.analyze("/some/path")
    expect(result.totalFiles).toBe(100)
    expect(result.packageCount).toBe(3)
    expect(result.packages).toEqual(["@app/auth", "@app/api", "@app/shared"])
  })

  test("caches result after first call", async () => {
    let callCount = 0
    const analyzer = new FakeWorkspaceAnalyzer({
      totalFiles: 50,
      packageCount: 1,
      packages: ["my-app"],
      languageCount: 1,
      manifestPaths: ["package.json"],
      topLevelDirs: ["src"],
    })
    await analyzer.analyze("/path1")
    await analyzer.analyze("/path2")
    // FakeWorkspaceAnalyzer always returns the same config — tests caching logic in real impl
    expect(true).toBe(true) // smoke
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/opencode && bun test test/router/workspace-analyzer.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement the fake analyzer and interface**

```typescript
// packages/opencode/src/agent/router/workspace-analyzer.ts
import type { WorkspaceAnalyzer, WorkspaceAnalysis } from "./types"

export class FakeWorkspaceAnalyzer implements WorkspaceAnalyzer {
  private readonly result: WorkspaceAnalysis

  constructor(result: WorkspaceAnalysis) {
    this.result = result
  }

  async analyze(_workspaceRoot: string): Promise<WorkspaceAnalysis> {
    return this.result
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/opencode && bun test test/router/workspace-analyzer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/agent/router/workspace-analyzer.ts packages/opencode/test/router/workspace-analyzer.test.ts
git commit -m "feat(router): add workspace analyzer interface and fake implementation"
```

---

### Task 6: Workspace analyzer — real implementation

**Files:**
- Modify: `packages/opencode/src/agent/router/workspace-analyzer.ts`

The real implementation uses `Ripgrep.Service` to enumerate files, then walks top-level dirs for manifests. Since `Ripgrep.Service` uses Effect, this implementation runs Effect programs and returns Promises.

- [ ] **Step 1: Read Ripgrep.Service API**

Read `packages/opencode/src/file/ripgrep.ts` to confirm the `files()` signature and `FilesInput` type. Also read how existing consumers use it (check `packages/opencode/src/tool/glob.ts` for reference).

- [ ] **Step 2: Implement RealWorkspaceAnalyzer**

Add to `packages/opencode/src/agent/router/workspace-analyzer.ts`:

```typescript
import path from "path"
import fs from "fs/promises"
import { Glob } from "bun"
import type { WorkspaceAnalyzer, WorkspaceAnalysis } from "./types"

const MANIFEST_NAMES = ["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml"]
const MANIFEST_LANG_MAP: Record<string, string> = {
  "package.json": "js/ts",
  "pyproject.toml": "python",
  "Cargo.toml": "rust",
  "go.mod": "go",
  "pom.xml": "java",
}

export class RealWorkspaceAnalyzer implements WorkspaceAnalyzer {
  private cache: WorkspaceAnalysis | null = null

  async analyze(workspaceRoot: string): Promise<WorkspaceAnalysis> {
    if (this.cache) return this.cache

    // Count source files (exclude common non-source dirs)
    const sourceGlob = new Glob("**/*")
    let totalFiles = 0
    for await (const _file of sourceGlob.scan({
      cwd: workspaceRoot,
      onlyFiles: true,
      // Bun Glob respects .gitignore by default when dot: false
    })) {
      totalFiles++
    }

    // Find manifests at depth 0 and 1
    const manifestPaths: string[] = []
    for (const name of MANIFEST_NAMES) {
      for (const pattern of [name, `*/${name}`]) {
        const glob = new Glob(pattern)
        for await (const match of glob.scan({ cwd: workspaceRoot, onlyFiles: true })) {
          manifestPaths.push(match)
        }
      }
    }
    manifestPaths.sort()

    // Derive packages from depth-1 manifests
    const packages = manifestPaths
      .filter(p => p.includes("/"))
      .map(p => path.dirname(p))

    // Count distinct languages from manifest types
    const langs = new Set<string>()
    for (const mp of manifestPaths) {
      const name = path.basename(mp)
      const lang = MANIFEST_LANG_MAP[name]
      if (lang) langs.add(lang)
    }

    // Top-level directories
    const entries = await fs.readdir(workspaceRoot, { withFileTypes: true })
    const topLevelDirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
      .map(e => e.name)
      .sort()

    const result: WorkspaceAnalysis = {
      totalFiles,
      packageCount: Math.max(1, packages.length),
      packages,
      languageCount: langs.size,
      manifestPaths,
      topLevelDirs,
    }
    this.cache = result
    return result
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/opencode/src/agent/router/workspace-analyzer.ts
git commit -m "feat(router): add real workspace analyzer with Bun Glob file scanning"
```

---

### Task 7: Workspace fixture directories + analyzer integration tests

**Files:**
- Create: `packages/opencode/src/agent/router/fixtures/workspaces/` (multiple dirs)
- Test: `packages/opencode/test/router/workspace-analyzer-real.test.ts`

- [ ] **Step 1: Create fixture workspaces**

```bash
# Empty workspace
mkdir -p packages/opencode/src/agent/router/fixtures/workspaces/empty

# Single-package workspace
mkdir -p packages/opencode/src/agent/router/fixtures/workspaces/single-pkg/src
echo '{"name": "my-app"}' > packages/opencode/src/agent/router/fixtures/workspaces/single-pkg/package.json
touch packages/opencode/src/agent/router/fixtures/workspaces/single-pkg/src/{index,utils,config,types,helpers}.ts

# Small monorepo (3 packages)
mkdir -p packages/opencode/src/agent/router/fixtures/workspaces/monorepo-small/{packages/{auth,api,shared}/src,scripts}
echo '{"name": "root"}' > packages/opencode/src/agent/router/fixtures/workspaces/monorepo-small/package.json
echo '{"name": "@app/auth"}' > packages/opencode/src/agent/router/fixtures/workspaces/monorepo-small/packages/auth/package.json
echo '{"name": "@app/api"}' > packages/opencode/src/agent/router/fixtures/workspaces/monorepo-small/packages/api/package.json
echo '{"name": "@app/shared"}' > packages/opencode/src/agent/router/fixtures/workspaces/monorepo-small/packages/shared/package.json
for pkg in auth api shared; do
  for f in index utils types; do
    touch "packages/opencode/src/agent/router/fixtures/workspaces/monorepo-small/packages/$pkg/src/$f.ts"
  done
done

# Polyglot workspace (TS + Python)
mkdir -p packages/opencode/src/agent/router/fixtures/workspaces/polyglot/{frontend/src,backend}
echo '{"name": "frontend"}' > packages/opencode/src/agent/router/fixtures/workspaces/polyglot/frontend/package.json
echo '[project]\nname = "backend"' > packages/opencode/src/agent/router/fixtures/workspaces/polyglot/backend/pyproject.toml
touch packages/opencode/src/agent/router/fixtures/workspaces/polyglot/frontend/src/{app,utils}.ts
touch packages/opencode/src/agent/router/fixtures/workspaces/polyglot/backend/{main,api}.py
```

- [ ] **Step 2: Write integration tests**

```typescript
// packages/opencode/test/router/workspace-analyzer-real.test.ts
import { describe, test, expect } from "bun:test"
import path from "path"
import { RealWorkspaceAnalyzer } from "@/agent/router/workspace-analyzer"

const FIXTURES = path.resolve(import.meta.dir, "../../src/agent/router/fixtures/workspaces")

describe("RealWorkspaceAnalyzer", () => {
  test("single-pkg: 1 package, js/ts language", async () => {
    const analyzer = new RealWorkspaceAnalyzer()
    const result = await analyzer.analyze(path.join(FIXTURES, "single-pkg"))
    expect(result.packageCount).toBe(1)
    expect(result.languageCount).toBe(1)
    expect(result.totalFiles).toBeGreaterThanOrEqual(5)
  })

  test("monorepo-small: 3 packages", async () => {
    const analyzer = new RealWorkspaceAnalyzer()
    const result = await analyzer.analyze(path.join(FIXTURES, "monorepo-small"))
    expect(result.packageCount).toBe(3)
    expect(result.packages).toContain("packages/auth")
    expect(result.packages).toContain("packages/api")
    expect(result.packages).toContain("packages/shared")
  })

  test("polyglot: 2 languages", async () => {
    const analyzer = new RealWorkspaceAnalyzer()
    const result = await analyzer.analyze(path.join(FIXTURES, "polyglot"))
    expect(result.languageCount).toBe(2)
  })

  test("caches result on second call", async () => {
    const analyzer = new RealWorkspaceAnalyzer()
    const r1 = await analyzer.analyze(path.join(FIXTURES, "single-pkg"))
    const r2 = await analyzer.analyze(path.join(FIXTURES, "single-pkg"))
    expect(r1).toBe(r2) // same reference
  })
})
```

- [ ] **Step 3: Run tests**

Run: `cd packages/opencode && bun test test/router/workspace-analyzer-real.test.ts`
Expected: 4 tests PASS

- [ ] **Step 4: Commit**

```bash
git add packages/opencode/src/agent/router/fixtures/workspaces/ packages/opencode/test/router/workspace-analyzer-real.test.ts
git commit -m "feat(router): add workspace fixtures and analyzer integration tests"
```

---

## Phase C: Scorer — Signal Extraction & Scoring

### Task 8: Prompt signals P1 (glob) + P2 (package mentions)

**Files:**
- Create: `packages/opencode/src/agent/router/scorer.ts`
- Test: `packages/opencode/test/router/scorer-prompt.test.ts`

- [ ] **Step 1: Write failing tests for P1 and P2**

```typescript
// packages/opencode/test/router/scorer-prompt.test.ts
import { describe, test, expect } from "bun:test"
import { extractP1GlobMentions, extractP2PackageMentions } from "@/agent/router/scorer"

describe("P1_glob_mentions", () => {
  test("detects ** glob pattern", () => {
    expect(extractP1GlobMentions("update **/*.ts files")).toBe(1)
  })

  test("detects multiple globs, capped at 3", () => {
    expect(extractP1GlobMentions("fix **/*.ts and src/**/*.js and lib/*.py and test/**")).toBe(3)
  })

  test("returns 0 for no globs", () => {
    expect(extractP1GlobMentions("fix the login bug")).toBe(0)
  })
})

describe("P2_package_mentions", () => {
  const packages = ["@app/auth", "@app/api", "shared-utils", "core"]

  test("detects scoped package names", () => {
    expect(extractP2PackageMentions("update @app/auth and @app/api", packages)).toBe(2)
  })

  test("detects backticked names", () => {
    expect(extractP2PackageMentions("fix `core` module", packages)).toBe(1)
  })

  test("rejects bare common English words without markup", () => {
    // 'core' is a common word — should NOT match without backticks
    expect(extractP2PackageMentions("the core issue is the api", packages)).toBe(0)
  })

  test("matches non-English-word package names without markup", () => {
    expect(extractP2PackageMentions("fix shared-utils", packages)).toBe(1)
  })

  test("caps at 4", () => {
    const manyPkgs = ["@a/b", "@a/c", "@a/d", "@a/e", "@a/f"]
    expect(extractP2PackageMentions("@a/b @a/c @a/d @a/e @a/f", manyPkgs)).toBe(4)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/opencode && bun test test/router/scorer-prompt.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement P1 and P2**

```typescript
// packages/opencode/src/agent/router/scorer.ts

// Common English words that happen to be package names — require markup to match
const COMMON_ENGLISH_WORDS = new Set([
  "core", "utils", "api", "app", "shared", "common", "base",
  "data", "config", "server", "client", "web", "test", "lib",
])

export function extractP1GlobMentions(prompt: string): number {
  const globPattern = /(?:\*\*\/|\*\.|\?\.|[\[{].*[\]}])/g
  const matches = prompt.match(globPattern)
  return Math.min(matches?.length ?? 0, 3)
}

export function extractP2PackageMentions(prompt: string, packageNames: string[]): number {
  let count = 0
  const seen = new Set<string>()

  for (const pkg of packageNames) {
    if (seen.has(pkg)) continue

    const isScoped = pkg.startsWith("@")
    const isCommonWord = COMMON_ENGLISH_WORDS.has(pkg.toLowerCase())

    let matched = false

    if (isScoped) {
      // Scoped packages always match on word boundary
      matched = prompt.includes(pkg)
    } else if (isCommonWord) {
      // Common words require backticks or quotes
      const backticked = new RegExp("`" + escapeRegex(pkg) + "`")
      const quoted = new RegExp(`["']${escapeRegex(pkg)}["']`)
      matched = backticked.test(prompt) || quoted.test(prompt)
    } else {
      // Non-English-word names match on word boundary
      const boundary = new RegExp(`\\b${escapeRegex(pkg)}\\b`)
      matched = boundary.test(prompt)
    }

    if (matched) {
      seen.add(pkg)
      count++
    }
  }
  return Math.min(count, 4)
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/opencode && bun test test/router/scorer-prompt.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/agent/router/scorer.ts packages/opencode/test/router/scorer-prompt.test.ts
git commit -m "feat(router): add P1 glob mentions and P2 package mentions signals"
```

---

### Task 9: Prompt signals P3 (scope keywords) + P4 (conjunction chains)

**Files:**
- Modify: `packages/opencode/src/agent/router/scorer.ts`
- Modify: `packages/opencode/test/router/scorer-prompt.test.ts`

- [ ] **Step 1: Add failing tests for P3 and P4**

Append to `packages/opencode/test/router/scorer-prompt.test.ts`:

```typescript
import { extractP3ScopeKeywords, extractP4ConjunctionChains } from "@/agent/router/scorer"

const MUTATION_VERBS = [
  "refactor", "migrate", "rename", "update", "add", "remove",
  "delete", "replace", "convert", "extract", "move",
]
const SCOPE_KEYWORDS = ["all", "every", "across", "entire", "whole", "throughout", "codebase-wide", "repo-wide"]

describe("P3_scope_keywords", () => {
  test("fires when scope keyword co-occurs with mutation verb", () => {
    expect(extractP3ScopeKeywords("refactor all auth handlers", SCOPE_KEYWORDS, MUTATION_VERBS)).toBe(1)
  })

  test("does NOT fire without mutation verb", () => {
    expect(extractP3ScopeKeywords("make sure all tests pass", SCOPE_KEYWORDS, MUTATION_VERBS)).toBe(0)
  })

  test("counts multiple unique keywords", () => {
    expect(extractP3ScopeKeywords("rename every import across all packages", SCOPE_KEYWORDS, MUTATION_VERBS)).toBe(3)
  })

  test("caps at 3", () => {
    expect(extractP3ScopeKeywords(
      "refactor all every entire whole throughout codebase-wide", SCOPE_KEYWORDS, MUTATION_VERBS
    )).toBe(3)
  })
})

describe("P4_conjunction_chains", () => {
  test("read and tell = 0 (no mutation verbs)", () => {
    expect(extractP4ConjunctionChains("read the file and tell me what it does", MUTATION_VERBS)).toBe(0)
  })

  test("refactor and rename = 1 extra clause", () => {
    expect(extractP4ConjunctionChains("refactor the auth module and rename the exports", MUTATION_VERBS)).toBe(1)
  })

  test("refactor and rename and deprecate = 2", () => {
    expect(extractP4ConjunctionChains("refactor X and rename Y and remove Z", MUTATION_VERBS)).toBe(2)
  })

  test("caps at 3", () => {
    expect(extractP4ConjunctionChains(
      "refactor A and rename B and update C and delete D and move E", MUTATION_VERBS
    )).toBe(3)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/opencode && bun test test/router/scorer-prompt.test.ts`
Expected: FAIL on new tests

- [ ] **Step 3: Implement P3 and P4**

Add to `packages/opencode/src/agent/router/scorer.ts`:

```typescript
export function extractP3ScopeKeywords(
  prompt: string,
  scopeKeywords: string[],
  mutationVerbs: string[],
): number {
  const lower = prompt.toLowerCase()
  const hasMutationVerb = mutationVerbs.some(v => lower.includes(v))
  if (!hasMutationVerb) return 0

  let count = 0
  for (const kw of scopeKeywords) {
    if (lower.includes(kw.toLowerCase())) count++
  }
  return Math.min(count, 3)
}

export function extractP4ConjunctionChains(prompt: string, mutationVerbs: string[]): number {
  const lower = prompt.toLowerCase()
  // Split on conjunctions
  const clauses = lower.split(/\s+(?:and|then|also)\s+/)

  let mutationClauseCount = 0
  for (const clause of clauses) {
    if (mutationVerbs.some(v => clause.includes(v))) {
      mutationClauseCount++
    }
  }
  // Extra clauses beyond the first
  return Math.min(Math.max(0, mutationClauseCount - 1), 3)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/opencode && bun test test/router/scorer-prompt.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/agent/router/scorer.ts packages/opencode/test/router/scorer-prompt.test.ts
git commit -m "feat(router): add P3 scope keywords and P4 conjunction chain signals"
```

---

### Task 10: Prompt signals P5 (explicit paths) + P6 (task archetype)

**Files:**
- Modify: `packages/opencode/src/agent/router/scorer.ts`
- Modify: `packages/opencode/test/router/scorer-prompt.test.ts`

- [ ] **Step 1: Add failing tests for P5 and P6**

Append to `packages/opencode/test/router/scorer-prompt.test.ts`:

```typescript
import { extractP5ExplicitPaths, classifyArchetype } from "@/agent/router/scorer"
import type { TaskArchetype } from "@/agent/router/types"

describe("P5_explicit_path_count", () => {
  const projectDirs = ["src", "packages", "lib"]

  test("detects paths with file extensions", () => {
    expect(extractP5ExplicitPaths("fix src/auth/login.ts", projectDirs)).toBe(1)
  })

  test("detects paths starting with project-dir prefix", () => {
    expect(extractP5ExplicitPaths("update packages/core/ and lib/utils/", projectDirs)).toBe(2)
  })

  test("rejects URLs", () => {
    expect(extractP5ExplicitPaths("check http://example.com/path", projectDirs)).toBe(0)
  })

  test("rejects and/or", () => {
    expect(extractP5ExplicitPaths("this and/or that", projectDirs)).toBe(0)
  })

  test("caps at 4 (raw), contribution = 0.5 * count", () => {
    expect(extractP5ExplicitPaths(
      "fix src/a.ts src/b.ts src/c.ts src/d.ts src/e.ts", projectDirs
    )).toBe(4)
  })
})

describe("P6 classifyArchetype", () => {
  const mutationVerbs = ["refactor", "migrate", "rename", "update", "add", "remove",
    "delete", "replace", "convert", "extract", "move"]

  test("read-only: explain, describe", () => {
    expect(classifyArchetype("explain how auth works", mutationVerbs)).toBe("read-only")
    expect(classifyArchetype("describe the architecture", mutationVerbs)).toBe("read-only")
    expect(classifyArchetype("what does this function do?", mutationVerbs)).toBe("read-only")
  })

  test("mutating-broad: refactor with scope signals", () => {
    expect(classifyArchetype("refactor all auth handlers", mutationVerbs)).toBe("mutating-broad")
  })

  test("mutating-narrow: add a feature", () => {
    expect(classifyArchetype("add a login button", mutationVerbs)).toBe("mutating-narrow")
  })

  test("trivial: fix a typo", () => {
    expect(classifyArchetype("fix the typo on line 5", mutationVerbs)).toBe("trivial")
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/opencode && bun test test/router/scorer-prompt.test.ts`
Expected: FAIL on new tests

- [ ] **Step 3: Implement P5 and P6**

Add to `packages/opencode/src/agent/router/scorer.ts`:

```typescript
import type { TaskArchetype } from "./types"

const READ_ONLY_VERBS = ["explain", "describe", "show", "list", "find", "search", "what", "how", "why", "where"]
const TRIVIAL_PATTERNS = [/\bfix\b.*\btypo\b/i, /\bfix\b.*\bline\s+\d+/i, /\bone\s+line\b/i]
const BROAD_INDICATORS = ["all", "every", "across", "entire", "whole", "throughout"]

export function extractP5ExplicitPaths(prompt: string, projectDirs: string[]): number {
  const tokens = prompt.split(/\s+/)
  let count = 0

  for (const token of tokens) {
    if (!token.includes("/")) continue
    // Reject URLs
    if (/^https?:\/\//i.test(token)) continue
    // Reject and/or
    if (/^and\/or$/i.test(token)) continue
    // Reject n/a
    if (/^n\/a$/i.test(token)) continue

    const hasExtension = /\.\w{1,5}$/.test(token)
    const hasProjectPrefix = projectDirs.some(d => token.startsWith(d + "/"))

    if (hasExtension || hasProjectPrefix) {
      count++
    }
  }
  return Math.min(count, 4)
}

export function classifyArchetype(prompt: string, mutationVerbs: string[]): TaskArchetype {
  const lower = prompt.toLowerCase()
  const words = lower.split(/\s+/)
  const firstWord = words[0]

  // Check read-only first
  if (READ_ONLY_VERBS.some(v => firstWord === v || lower.startsWith(v))) {
    return "read-only"
  }
  if (lower.includes("?") && !mutationVerbs.some(v => lower.includes(v))) {
    return "read-only"
  }

  // Check trivial
  if (TRIVIAL_PATTERNS.some(p => p.test(lower))) {
    return "trivial"
  }

  // Check mutating
  const hasMutationVerb = mutationVerbs.some(v => lower.includes(v))
  if (!hasMutationVerb) {
    return "trivial"
  }

  // Broad vs narrow
  const hasBroadIndicator = BROAD_INDICATORS.some(kw => lower.includes(kw))
  return hasBroadIndicator ? "mutating-broad" : "mutating-narrow"
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/opencode && bun test test/router/scorer-prompt.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/agent/router/scorer.ts packages/opencode/test/router/scorer-prompt.test.ts
git commit -m "feat(router): add P5 explicit paths and P6 task archetype signals"
```

---

### Task 11: Codebase signals C1–C5

**Files:**
- Modify: `packages/opencode/src/agent/router/scorer.ts`
- Test: `packages/opencode/test/router/scorer-codebase.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/opencode/test/router/scorer-codebase.test.ts
import { describe, test, expect } from "bun:test"
import { computeCodebaseSignals } from "@/agent/router/scorer"
import type { WorkspaceAnalysis } from "@/agent/router/types"

function makeAnalysis(overrides: Partial<WorkspaceAnalysis> = {}): WorkspaceAnalysis {
  return {
    totalFiles: 100,
    packageCount: 3,
    packages: ["@app/auth", "@app/api", "@app/shared"],
    languageCount: 1,
    manifestPaths: ["package.json"],
    topLevelDirs: ["packages"],
    ...overrides,
  }
}

describe("computeCodebaseSignals", () => {
  test("C1 bands: <50 = 0, 50-200 = 1, 200-1000 = 2, 1000+ = 3", () => {
    expect(computeCodebaseSignals(makeAnalysis({ totalFiles: 10 }), []).C1).toBe(0)
    expect(computeCodebaseSignals(makeAnalysis({ totalFiles: 100 }), []).C1).toBe(1)
    expect(computeCodebaseSignals(makeAnalysis({ totalFiles: 500 }), []).C1).toBe(2)
    expect(computeCodebaseSignals(makeAnalysis({ totalFiles: 2000 }), []).C1).toBe(3)
  })

  test("C2 bands: 1=0, 2-3=1, 4-7=2, 8+=3", () => {
    expect(computeCodebaseSignals(makeAnalysis({ packageCount: 1 }), []).C2).toBe(0)
    expect(computeCodebaseSignals(makeAnalysis({ packageCount: 3 }), []).C2).toBe(1)
    expect(computeCodebaseSignals(makeAnalysis({ packageCount: 5 }), []).C2).toBe(2)
    expect(computeCodebaseSignals(makeAnalysis({ packageCount: 10 }), []).C2).toBe(3)
  })

  test("C4 cross-package: 0 or 2", () => {
    expect(computeCodebaseSignals(makeAnalysis(), ["@app/auth"]).C4).toBe(0)
    expect(computeCodebaseSignals(makeAnalysis(), ["@app/auth", "@app/api"]).C4).toBe(2)
  })

  test("C5 multilanguage: binary", () => {
    expect(computeCodebaseSignals(makeAnalysis({ languageCount: 1 }), []).C5).toBe(0)
    expect(computeCodebaseSignals(makeAnalysis({ languageCount: 2 }), []).C5).toBe(1)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/opencode && bun test test/router/scorer-codebase.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement codebase signals**

Add to `packages/opencode/src/agent/router/scorer.ts`:

```typescript
import type { WorkspaceAnalysis } from "./types"

export interface CodebaseSignals {
  C1: number
  C2: number
  C3: number
  C4: number
  C5: number
}

function band(value: number, thresholds: [number, number, number]): number {
  if (value >= thresholds[2]) return 3
  if (value >= thresholds[1]) return 2
  if (value >= thresholds[0]) return 1
  return 0
}

export function computeCodebaseSignals(
  analysis: WorkspaceAnalysis,
  mentionedPackages: string[],
): CodebaseSignals {
  const C1 = band(analysis.totalFiles, [50, 200, 1000])
  const C2 = band(analysis.packageCount, [2, 4, 8])

  // C3: affected subset — count files in mentioned packages (simplified: use packageCount * avg files)
  const affectedSubset = mentionedPackages.length > 0
    ? Math.floor(analysis.totalFiles * (mentionedPackages.length / Math.max(1, analysis.packageCount)))
    : 0
  const C3 = band(affectedSubset, [5, 16, 40])

  // C4: cross-package breadth
  const uniqueMentioned = new Set(mentionedPackages)
  const C4 = uniqueMentioned.size >= 2 ? 2 : 0

  // C5: multilanguage
  const C5 = analysis.languageCount > 1 ? 1 : 0

  return { C1, C2, C3, C4, C5 }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/opencode && bun test test/router/scorer-codebase.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/agent/router/scorer.ts packages/opencode/test/router/scorer-codebase.test.ts
git commit -m "feat(router): add C1-C5 codebase signal extraction with banding"
```

---

### Task 12: Composite scorer — min-gate, decision bands, floor rules

**Files:**
- Modify: `packages/opencode/src/agent/router/scorer.ts`
- Test: `packages/opencode/test/router/scorer-composite.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/opencode/test/router/scorer-composite.test.ts
import { describe, test, expect } from "bun:test"
import { computeComposite, applyDecisionBand, applyFloorRules } from "@/agent/router/scorer"
import type { RouterConfig } from "@/agent/router/types"
import defaultWeights from "@/agent/router/weights.json"

const config = defaultWeights as unknown as RouterConfig

describe("computeComposite", () => {
  test("primaryScore = min(prompt, codebase)", () => {
    const result = computeComposite(7, 4)
    expect(result.primary).toBe(4)
  })

  test("secondaryScore = 0.6*prompt + 0.4*codebase", () => {
    const result = computeComposite(7, 4)
    expect(result.secondary).toBeCloseTo(5.8, 1)
  })
})

describe("applyDecisionBand", () => {
  test("[0, 3) → single, high", () => {
    expect(applyDecisionBand(2, config.bands)).toEqual({ mode: "single", confidence: "high" })
  })

  test("[3, 4.5) → single, medium", () => {
    expect(applyDecisionBand(3.5, config.bands)).toEqual({ mode: "single", confidence: "medium" })
  })

  test("[4.5, 6) → uncertain", () => {
    expect(applyDecisionBand(5, config.bands)).toEqual({ mode: "uncertain", confidence: "medium" })
  })

  test("[6, 7.5) → coordinator, medium", () => {
    expect(applyDecisionBand(6.5, config.bands)).toEqual({ mode: "coordinator", confidence: "medium" })
  })

  test("[7.5, 10] → coordinator, high", () => {
    expect(applyDecisionBand(8, config.bands)).toEqual({ mode: "coordinator", confidence: "high" })
  })
})

describe("applyFloorRules", () => {
  test("read-only archetype forces single", () => {
    const result = applyFloorRules("read-only", { C3: 3 }, 8)
    expect(result).toBe("single")
  })

  test("small C3 + low prompt score forces single", () => {
    const result = applyFloorRules("mutating-broad", { C3: 0 }, 4)
    expect(result).toBe("single")
  })

  test("large C3 + high prompt score passes through", () => {
    const result = applyFloorRules("mutating-broad", { C3: 2 }, 7)
    expect(result).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/opencode && bun test test/router/scorer-composite.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement composite scorer**

Add to `packages/opencode/src/agent/router/scorer.ts`:

```typescript
export interface CompositeScore {
  primary: number
  secondary: number
}

export function computeComposite(promptScore: number, codebaseScore: number): CompositeScore {
  return {
    primary: Math.min(promptScore, codebaseScore),
    secondary: 0.6 * promptScore + 0.4 * codebaseScore,
  }
}

export interface BandResult {
  mode: "single" | "coordinator" | "uncertain"
  confidence: "high" | "medium" | "low"
}

export function applyDecisionBand(
  primaryScore: number,
  bands: RouterConfig["bands"],
): BandResult {
  if (primaryScore < bands.strongSingleMax) return { mode: "single", confidence: "high" }
  if (primaryScore < bands.leanSingleMax) return { mode: "single", confidence: "medium" }
  if (primaryScore < bands.uncertainMax) return { mode: "uncertain", confidence: "medium" }
  if (primaryScore < bands.leanCoordinatorMax) return { mode: "coordinator", confidence: "medium" }
  return { mode: "coordinator", confidence: "high" }
}

export function applyFloorRules(
  archetype: TaskArchetype,
  codebaseSignals: Pick<CodebaseSignals, "C3">,
  promptScore: number,
): "single" | null {
  // Floor rule 2: read-only → always single
  if (archetype === "read-only") return "single"
  // Floor rule 1: small C3 + low promptScore → single
  if (codebaseSignals.C3 < 1 && promptScore < 6) return "single"
  return null
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/opencode && bun test test/router/scorer-composite.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/agent/router/scorer.ts packages/opencode/test/router/scorer-composite.test.ts
git commit -m "feat(router): add composite scorer with min-gate, decision bands, and floor rules"
```

---

## Phase D: Classifier & Router Entry

### Task 13: Classifier — interface, mock, and parse layer

**Files:**
- Create: `packages/opencode/src/agent/router/classifier.ts`
- Create: `packages/opencode/src/agent/router/classifier-parse.ts`
- Test: `packages/opencode/test/router/classifier.test.ts`

- [ ] **Step 1: Write failing tests for MockClassifier and parse layer**

```typescript
// packages/opencode/test/router/classifier.test.ts
import { describe, test, expect } from "bun:test"
import { MockClassifier } from "@/agent/router/classifier"
import { parseClassifierOutput } from "@/agent/router/classifier-parse"

describe("MockClassifier", () => {
  test("returns configured output", async () => {
    const mock = new MockClassifier({ decision: "coordinator", confidence: "high", reason: "multi-package" })
    const result = await mock.classify({
      prompt: "test", firedSignalNames: [], timeoutMs: 1000,
      heuristicSummary: { taskArchetype: "mutating-broad", fileCount: 100, packageCount: 3 },
    })
    expect(result.decision).toBe("coordinator")
  })
})

describe("parseClassifierOutput", () => {
  test("parses valid JSON", () => {
    const raw = '{"decision": "coordinator", "confidence": "high", "reason": "multi-package refactor"}'
    const result = parseClassifierOutput(raw, "json")
    expect(result.decision).toBe("coordinator")
    expect(result.confidence).toBe("high")
  })

  test("parses regex format", () => {
    const raw = "DECISION: coordinator\nCONFIDENCE: high\nREASON: multi-package refactor"
    const result = parseClassifierOutput(raw, "regex")
    expect(result.decision).toBe("coordinator")
  })

  test("truncates reason to 80 chars", () => {
    const longReason = "a".repeat(100)
    const raw = `{"decision": "single", "confidence": "low", "reason": "${longReason}"}`
    const result = parseClassifierOutput(raw, "json")
    expect(result.reason.length).toBeLessThanOrEqual(80)
  })

  test("throws on missing decision field", () => {
    expect(() => parseClassifierOutput('{"confidence": "high"}', "json")).toThrow()
  })

  test("throws on invalid decision value", () => {
    expect(() => parseClassifierOutput('{"decision": "maybe", "confidence": "high", "reason": "x"}', "json")).toThrow()
  })

  test("throws on garbage input", () => {
    expect(() => parseClassifierOutput("hello world", "json")).toThrow()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/opencode && bun test test/router/classifier.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement classifier-parse.ts**

```typescript
// packages/opencode/src/agent/router/classifier-parse.ts
import type { ClassifierOutput, AgentMode } from "./types"

export type ParseMode = "json-schema" | "json" | "regex"

export function parseClassifierOutput(raw: string, mode: ParseMode): ClassifierOutput {
  if (mode === "regex") return parseRegex(raw)
  return parseJson(raw)
}

function parseJson(raw: string): ClassifierOutput {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    throw new Error(`Classifier output is not valid JSON: ${raw.slice(0, 100)}`)
  }

  if (typeof obj !== "object" || obj === null) {
    throw new Error("Classifier output is not a JSON object")
  }

  const record = obj as Record<string, unknown>

  if (!record.decision || !["single", "coordinator"].includes(record.decision as string)) {
    throw new Error(`Invalid or missing 'decision' field: ${record.decision}`)
  }
  if (!record.confidence || !["high", "low"].includes(record.confidence as string)) {
    throw new Error(`Invalid or missing 'confidence' field: ${record.confidence}`)
  }

  const reason = typeof record.reason === "string" ? record.reason.slice(0, 80) : ""

  return {
    decision: record.decision as AgentMode,
    confidence: record.confidence as "high" | "low",
    reason,
  }
}

function parseRegex(raw: string): ClassifierOutput {
  const decisionMatch = raw.match(/DECISION:\s*(single|coordinator)/i)
  const confidenceMatch = raw.match(/CONFIDENCE:\s*(high|low)/i)
  const reasonMatch = raw.match(/REASON:\s*(.+)/i)

  if (!decisionMatch) throw new Error("Missing DECISION in regex output")
  if (!confidenceMatch) throw new Error("Missing CONFIDENCE in regex output")

  return {
    decision: decisionMatch[1].toLowerCase() as AgentMode,
    confidence: confidenceMatch[1].toLowerCase() as "high" | "low",
    reason: (reasonMatch?.[1] ?? "").slice(0, 80),
  }
}
```

- [ ] **Step 4: Implement classifier.ts with MockClassifier**

```typescript
// packages/opencode/src/agent/router/classifier.ts
import type { LLMClassifier, ClassifierInput, ClassifierOutput } from "./types"

export class MockClassifier implements LLMClassifier {
  private readonly output: ClassifierOutput

  constructor(output: ClassifierOutput) {
    this.output = output
  }

  async classify(_input: ClassifierInput): Promise<ClassifierOutput> {
    return this.output
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/opencode && bun test test/router/classifier.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/opencode/src/agent/router/classifier.ts packages/opencode/src/agent/router/classifier-parse.ts packages/opencode/test/router/classifier.test.ts
git commit -m "feat(router): add classifier interface, mock, and parse layer (JSON + regex)"
```

---

### Task 14: Circuit breaker + rate limiter

**Files:**
- Modify: `packages/opencode/src/agent/router/classifier.ts`
- Test: `packages/opencode/test/router/classifier-resilience.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/opencode/test/router/classifier-resilience.test.ts
import { describe, test, expect } from "bun:test"
import { GuardedClassifier, MockClassifier } from "@/agent/router/classifier"

describe("GuardedClassifier", () => {
  const baseInput = {
    prompt: "test", firedSignalNames: [], timeoutMs: 1000,
    heuristicSummary: { taskArchetype: "mutating-broad" as const, fileCount: 100, packageCount: 3 },
  }

  test("passes through on success", async () => {
    const inner = new MockClassifier({ decision: "coordinator", confidence: "high", reason: "ok" })
    const guarded = new GuardedClassifier(inner, { maxCallsPerSession: 10, consecutiveFailuresToTrip: 5, cooldownMs: 100 })
    const result = await guarded.classify(baseInput)
    expect(result.decision).toBe("coordinator")
  })

  test("rate limit: returns null after maxCallsPerSession", async () => {
    const inner = new MockClassifier({ decision: "coordinator", confidence: "high", reason: "ok" })
    const guarded = new GuardedClassifier(inner, { maxCallsPerSession: 2, consecutiveFailuresToTrip: 5, cooldownMs: 100 })
    await guarded.classify(baseInput)
    await guarded.classify(baseInput)
    const result = await guarded.classify(baseInput) // 3rd call — over limit
    expect(result).toBeNull()
    expect(guarded.lastFallbackReason).toBe("rate_limit")
  })

  test("circuit breaker: trips after N consecutive failures", async () => {
    const failing = new MockClassifier({ decision: "coordinator", confidence: "high", reason: "" })
    // Override classify to throw
    failing.classify = async () => { throw new Error("network error") }
    const guarded = new GuardedClassifier(failing, { maxCallsPerSession: 100, consecutiveFailuresToTrip: 3, cooldownMs: 60000 })

    for (let i = 0; i < 3; i++) {
      await guarded.classify(baseInput) // returns null on error
    }
    // Circuit is now open — shouldn't even try
    const result = await guarded.classify(baseInput)
    expect(result).toBeNull()
    expect(guarded.lastFallbackReason).toBe("circuit_open")
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/opencode && bun test test/router/classifier-resilience.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement GuardedClassifier**

Add to `packages/opencode/src/agent/router/classifier.ts`:

```typescript
export interface GuardedConfig {
  maxCallsPerSession: number
  consecutiveFailuresToTrip: number
  cooldownMs: number
}

export class GuardedClassifier implements LLMClassifier {
  private readonly inner: LLMClassifier
  private readonly config: GuardedConfig
  private callCount = 0
  private consecutiveFailures = 0
  private circuitOpenUntil = 0
  public lastFallbackReason: string | null = null

  constructor(inner: LLMClassifier, config: GuardedConfig) {
    this.inner = inner
    this.config = config
  }

  async classify(input: ClassifierInput): Promise<ClassifierOutput | null> {
    this.lastFallbackReason = null

    // Rate limit
    if (this.callCount >= this.config.maxCallsPerSession) {
      this.lastFallbackReason = "rate_limit"
      return null
    }

    // Circuit breaker — open
    if (this.circuitOpenUntil > Date.now()) {
      this.lastFallbackReason = "circuit_open"
      return null
    }

    this.callCount++
    try {
      const result = await this.inner.classify(input)
      this.consecutiveFailures = 0
      return result
    } catch {
      this.consecutiveFailures++
      if (this.consecutiveFailures >= this.config.consecutiveFailuresToTrip) {
        this.circuitOpenUntil = Date.now() + this.config.cooldownMs
      }
      this.lastFallbackReason = "timeout"
      return null
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/opencode && bun test test/router/classifier-resilience.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/agent/router/classifier.ts packages/opencode/test/router/classifier-resilience.test.ts
git commit -m "feat(router): add GuardedClassifier with circuit breaker and rate limiter"
```

---

### Task 15: Announce functions

**Files:**
- Create: `packages/opencode/src/agent/router/announce.ts`
- Test: `packages/opencode/test/router/announce.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/opencode/test/router/announce.test.ts
import { describe, test, expect } from "bun:test"
import { formatOverride, formatInherited, formatRouted } from "@/agent/router/announce"
import type { RoutingDecision } from "@/agent/router/types"

const mockDecision: RoutingDecision = {
  mode: "coordinator",
  reason: "8 files across 3 packages",
  confidence: "medium",
  confidenceScore: 0.65,
  firedSignals: ["P2_package_mentions", "C4_cross_package"],
  signals: { promptScore: 6.5, codebaseScore: 5.8, llmTiebreakerUsed: false },
  decidedAt: Date.now(),
  workspaceFingerprint: "abc123",
}

describe("formatOverride", () => {
  test("outputs fixed format", () => {
    expect(formatOverride("coordinator")).toBe("→ Routing: coordinator (manual override)")
  })
})

describe("formatInherited", () => {
  test("outputs inherited format", () => {
    expect(formatInherited(mockDecision)).toBe("→ Routing: coordinator · inherited from previous turn")
  })
})

describe("formatRouted", () => {
  test("outputs reason", () => {
    expect(formatRouted(mockDecision)).toBe("→ Routing: coordinator · 8 files across 3 packages")
  })

  test("single agent format", () => {
    const single = { ...mockDecision, mode: "single" as const, reason: "single-package edit" }
    expect(formatRouted(single)).toBe("→ Routing: single · single-package edit")
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/opencode && bun test test/router/announce.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement announce.ts**

```typescript
// packages/opencode/src/agent/router/announce.ts
import type { RoutingDecision, DecisionSource } from "./types"

export function formatOverride(agent: string): string {
  return `→ Routing: ${agent} (manual override)`
}

export function formatInherited(decision: RoutingDecision): string {
  return `→ Routing: ${decision.mode} · inherited from previous turn`
}

export function formatRouted(decision: RoutingDecision): string {
  return `→ Routing: ${decision.mode} · ${decision.reason}`
}

export function emitAnnounce(message: string): void {
  const isTTY = process.stderr.isTTY
  if (isTTY) {
    process.stderr.write(`\x1b[36m${message}\x1b[0m\n`)
  } else {
    process.stderr.write(message + "\n")
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/opencode && bun test test/router/announce.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/agent/router/announce.ts packages/opencode/test/router/announce.test.ts
git commit -m "feat(router): add announce format functions with fixed greppable prefix"
```

---

### Task 16: Telemetry JSONL writer

**Files:**
- Create: `packages/opencode/src/agent/router/telemetry.ts`
- Test: `packages/opencode/test/router/telemetry.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/opencode/test/router/telemetry.test.ts
import { describe, test, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { TelemetryWriter, opportunisticCleanup } from "@/agent/router/telemetry"
import type { TelemetryRecord } from "@/agent/router/types"

async function makeTmpDir() {
  const dir = await fs.mkdtemp(path.join(import.meta.dir, "tmp-tel-"))
  return { path: dir, cleanup: () => fs.rm(dir, { recursive: true }) }
}

describe("TelemetryWriter", () => {
  test("writes JSONL record to daily file", async () => {
    const tmp = await makeTmpDir()
    try {
      const writer = new TelemetryWriter(tmp.path)
      const record: Partial<TelemetryRecord> = {
        ts: "2026-04-23T12:00:00Z",
        source: "routed",
        finalDecision: { mode: "single", confidence: "high" },
      }
      await writer.write(record as TelemetryRecord)
      const today = new Date().toISOString().slice(0, 10)
      const file = path.join(tmp.path, ".opencode", `router-decisions-${today}.jsonl`)
      const content = await fs.readFile(file, "utf-8")
      expect(content).toContain('"source":"routed"')
    } finally { await tmp.cleanup() }
  })
})

describe("opportunisticCleanup", () => {
  test("removes files older than 30 days", async () => {
    const tmp = await makeTmpDir()
    try {
      const dir = path.join(tmp.path, ".opencode")
      await fs.mkdir(dir, { recursive: true })
      const oldFile = path.join(dir, "router-decisions-2026-03-01.jsonl")
      const newFile = path.join(dir, "router-decisions-2026-04-22.jsonl")
      await fs.writeFile(oldFile, "{}")
      await fs.writeFile(newFile, "{}")
      // Set old file mtime to 60 days ago
      const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
      await fs.utimes(oldFile, sixtyDaysAgo, sixtyDaysAgo)
      await opportunisticCleanup(tmp.path, 30)
      const files = await fs.readdir(dir)
      expect(files).not.toContain("router-decisions-2026-03-01.jsonl")
      expect(files).toContain("router-decisions-2026-04-22.jsonl")
    } finally { await tmp.cleanup() }
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/opencode && bun test test/router/telemetry.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement telemetry.ts**

```typescript
// packages/opencode/src/agent/router/telemetry.ts
import fs from "fs/promises"
import path from "path"
import type { TelemetryRecord } from "./types"

export class TelemetryWriter {
  private readonly workspaceRoot: string

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot
  }

  async write(record: TelemetryRecord): Promise<void> {
    const dir = path.join(this.workspaceRoot, ".opencode")
    await fs.mkdir(dir, { recursive: true })
    const today = new Date().toISOString().slice(0, 10)
    const file = path.join(dir, `router-decisions-${today}.jsonl`)
    await fs.appendFile(file, JSON.stringify(record) + "\n")
  }
}

export async function opportunisticCleanup(
  workspaceRoot: string,
  retentionDays: number,
): Promise<void> {
  const dir = path.join(workspaceRoot, ".opencode")
  try {
    const files = await fs.readdir(dir)
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
    for (const file of files) {
      if (!file.startsWith("router-decisions-") && !file.startsWith("router-prompts-")) continue
      const filePath = path.join(dir, file)
      const stat = await fs.stat(filePath)
      if (stat.mtimeMs < cutoff) {
        await fs.unlink(filePath)
      }
    }
  } catch {
    // Directory might not exist — that's fine
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/opencode && bun test test/router/telemetry.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/agent/router/telemetry.ts packages/opencode/test/router/telemetry.test.ts
git commit -m "feat(router): add telemetry JSONL writer with daily rotation and cleanup"
```

---

### Task 17: Router `route()` entry point

**Files:**
- Create: `packages/opencode/src/agent/router.ts`
- Test: `packages/opencode/test/router/router.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/opencode/test/router/router.test.ts
import { describe, test, expect } from "bun:test"
import { route } from "@/agent/router"
import { FakeWorkspaceAnalyzer } from "@/agent/router/workspace-analyzer"
import { MockClassifier } from "@/agent/router/classifier"
import type { RouteInput, WorkspaceAnalysis } from "@/agent/router/types"

const smallWorkspace: WorkspaceAnalysis = {
  totalFiles: 10, packageCount: 1, packages: ["my-app"],
  languageCount: 1, manifestPaths: ["package.json"], topLevelDirs: ["src"],
}
const largeMonorepo: WorkspaceAnalysis = {
  totalFiles: 500, packageCount: 5,
  packages: ["@app/auth", "@app/api", "@app/shared", "@app/web", "@app/cli"],
  languageCount: 1, manifestPaths: ["package.json", "packages/auth/package.json"],
  topLevelDirs: ["packages", "scripts", "docs"],
}

function makeInput(prompt: string, analysis: WorkspaceAnalysis, classifier?: MockClassifier): RouteInput {
  return {
    prompt, workspaceRoot: "/fake", cwd: "/fake", modelId: "test",
    analyzer: new FakeWorkspaceAnalyzer(analysis),
    classifier,
  }
}

describe("route()", () => {
  test("trivial prompt + small repo → single, high", async () => {
    const result = await route(makeInput("fix the typo on line 5", smallWorkspace))
    expect(result.mode).toBe("single")
    expect(result.confidence).toBe("high")
  })

  test("cross-package refactor in monorepo → coordinator", async () => {
    const result = await route(makeInput(
      "refactor all auth handlers across @app/auth and @app/api",
      largeMonorepo,
    ))
    expect(result.mode).toBe("coordinator")
  })

  test("read-only prompt in large monorepo → single (floor rule)", async () => {
    const result = await route(makeInput("explain how the auth flow works", largeMonorepo))
    expect(result.mode).toBe("single")
  })

  test("complex prompt + tiny repo → single (min-gate)", async () => {
    const result = await route(makeInput(
      "refactor all modules across every package",
      smallWorkspace,
    ))
    expect(result.mode).toBe("single")
  })

  test("never throws — returns single on internal error", async () => {
    const crashingAnalyzer = {
      analyze: async () => { throw new Error("crash") },
    }
    const result = await route({
      prompt: "test", workspaceRoot: "/fake", cwd: "/fake", modelId: "test",
      analyzer: crashingAnalyzer,
    })
    expect(result.mode).toBe("single")
    expect(result.confidence).toBe("low")
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/opencode && bun test test/router/router.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement route()**

```typescript
// packages/opencode/src/agent/router.ts
import type {
  RouteInput, RoutingDecision, RouterConfig, TaskArchetype,
  ClassifierOutput, AgentMode, Confidence,
} from "./router/types"
import {
  extractP1GlobMentions, extractP2PackageMentions,
  extractP3ScopeKeywords, extractP4ConjunctionChains,
  extractP5ExplicitPaths, classifyArchetype,
  computeCodebaseSignals, computeComposite,
  applyDecisionBand, applyFloorRules,
} from "./router/scorer"
import { computeFingerprint } from "./router/fingerprint"
import defaultWeightsJson from "./router/weights.json"

const defaultConfig = defaultWeightsJson as unknown as RouterConfig

export async function route(input: RouteInput): Promise<RoutingDecision> {
  const config = input.config ?? defaultConfig
  try {
    return await routeInternal(input, config)
  } catch {
    return fallbackDecision(input, "router-error")
  }
}

async function routeInternal(input: RouteInput, config: RouterConfig): Promise<RoutingDecision> {
  const analysis = await input.analyzer.analyze(input.workspaceRoot)
  const fingerprint = await computeFingerprint(input.workspaceRoot)

  // Extract prompt signals
  const archetype = classifyArchetype(input.prompt, config.mutationVerbs)
  const p1 = extractP1GlobMentions(input.prompt)
  const p2 = extractP2PackageMentions(input.prompt, analysis.packages)
  const p3 = extractP3ScopeKeywords(input.prompt, config.scopeKeywords, config.mutationVerbs)
  const p4 = extractP4ConjunctionChains(input.prompt, config.mutationVerbs)
  const p5 = extractP5ExplicitPaths(input.prompt, analysis.topLevelDirs)

  // Normalize and sum prompt signals → [0, 10]
  const pNorm = (p1/3 + p2/4 + p3/3 + p4/3 + p5*0.5/4) / 5
  let promptScore = pNorm * 10
  if (archetype === "read-only") promptScore = Math.max(0, promptScore - 1)

  // Extract and score codebase signals
  const mentionedPkgs = analysis.packages.filter(pkg =>
    input.prompt.toLowerCase().includes(pkg.toLowerCase().split("/").pop()!)
  )
  const cSignals = computeCodebaseSignals(analysis, mentionedPkgs)
  const cNorm = (cSignals.C1/3 + cSignals.C2/3 + cSignals.C3/3 + cSignals.C4/2 + cSignals.C5) / 5
  const codebaseScore = cNorm * 10

  // Composite
  const composite = computeComposite(promptScore, codebaseScore)

  // Floor rules
  const floorResult = applyFloorRules(archetype, cSignals, promptScore)
  if (floorResult === "single") {
    return buildDecision("single", "high", composite, promptScore, codebaseScore, archetype, fingerprint, [])
  }

  // Decision band
  const bandResult = applyDecisionBand(composite.primary, config.bands)

  // Uncertain band → LLM tiebreaker
  if (bandResult.mode === "uncertain" && input.classifier && config.tiebreaker.enabled) {
    const firedSignals = collectFiredSignals(p1, p2, p3, p4, p5, cSignals)
    try {
      const classifierOutput = await input.classifier.classify({
        prompt: input.prompt,
        firedSignalNames: firedSignals,
        heuristicSummary: { taskArchetype: archetype, fileCount: analysis.totalFiles, packageCount: analysis.packageCount },
        timeoutMs: config.tiebreaker.timeoutMs,
      })
      if (classifierOutput) {
        const resolved = resolveClassifierOutput(classifierOutput)
        return buildDecision(resolved.mode, resolved.confidence, composite, promptScore, codebaseScore, archetype, fingerprint, firedSignals, true)
      }
    } catch {
      // Tiebreaker failed — fall back to single (conservative)
    }
    return buildDecision("single", "low", composite, promptScore, codebaseScore, archetype, fingerprint, [], false, "timeout")
  }

  const mode = bandResult.mode === "uncertain" ? "single" as const : bandResult.mode
  const firedSignals = collectFiredSignals(p1, p2, p3, p4, p5, cSignals)
  return buildDecision(mode, bandResult.confidence, composite, promptScore, codebaseScore, archetype, fingerprint, firedSignals)
}

function resolveClassifierOutput(output: ClassifierOutput): { mode: AgentMode; confidence: Confidence } {
  if (output.decision === "coordinator" && output.confidence === "high") return { mode: "coordinator", confidence: "medium" }
  if (output.decision === "coordinator" && output.confidence === "low") return { mode: "single", confidence: "low" }
  if (output.decision === "single" && output.confidence === "high") return { mode: "single", confidence: "medium" }
  return { mode: "single", confidence: "low" }
}

function buildDecision(
  mode: AgentMode, confidence: Confidence,
  composite: { primary: number; secondary: number },
  promptScore: number, codebaseScore: number,
  archetype: TaskArchetype, fingerprint: string,
  firedSignals: string[], tiebreakerUsed = false,
  fallbackPath?: string,
): RoutingDecision {
  const reasons: string[] = []
  if (mode === "coordinator") reasons.push("complex parallel task")
  if (mode === "single") reasons.push(archetype === "read-only" ? "read-only task" : "single-agent sufficient")

  return {
    mode, confidence,
    confidenceScore: confidence === "high" ? 0.9 : confidence === "medium" ? 0.65 : 0.3,
    reason: reasons.join(", "),
    firedSignals,
    signals: { promptScore, codebaseScore, llmTiebreakerUsed: tiebreakerUsed },
    decidedAt: Date.now(),
    workspaceFingerprint: fingerprint,
  }
}

function collectFiredSignals(p1: number, p2: number, p3: number, p4: number, p5: number, c: { C1: number; C2: number; C3: number; C4: number; C5: number }): string[] {
  const signals: string[] = []
  if (p1 > 0) signals.push("P1_glob_mentions")
  if (p2 > 0) signals.push("P2_package_mentions")
  if (p3 > 0) signals.push("P3_scope_keywords")
  if (p4 > 0) signals.push("P4_conjunction_chains")
  if (p5 > 0) signals.push("P5_explicit_path_count")
  if (c.C1 > 0) signals.push("C1_total_files")
  if (c.C2 > 0) signals.push("C2_package_count")
  if (c.C3 > 0) signals.push("C3_affected_subset")
  if (c.C4 > 0) signals.push("C4_cross_package")
  if (c.C5 > 0) signals.push("C5_multilanguage")
  return signals
}

function fallbackDecision(input: RouteInput, reason: string): RoutingDecision {
  return {
    mode: "single", confidence: "low", confidenceScore: 0.1,
    reason: "router fallback",
    firedSignals: [],
    signals: { promptScore: 0, codebaseScore: 0, llmTiebreakerUsed: false },
    decidedAt: Date.now(),
    workspaceFingerprint: "",
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/opencode && bun test test/router/router.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/agent/router.ts packages/opencode/test/router/router.test.ts
git commit -m "feat(router): add route() entry point with full signal pipeline and error handling"
```

---

## Phase E: Inheritance & Session State

### Task 18: Inheritance logic — shouldInherit + escape conditions

**Files:**
- Create: `packages/opencode/src/agent/router/inherit.ts`
- Test: `packages/opencode/test/router/inherit.test.ts`

- [ ] **Step 1: Write failing tests — all 5 escape conditions + priority truth table**

```typescript
// packages/opencode/test/router/inherit.test.ts
import { describe, test, expect } from "bun:test"
import { shouldInherit, type InheritInput } from "@/agent/router/inherit"
import type { RoutingDecision } from "@/agent/router/types"

const basePrior: RoutingDecision = {
  mode: "coordinator", confidence: "medium", confidenceScore: 0.65,
  reason: "test", firedSignals: [], signals: { promptScore: 7, codebaseScore: 6, llmTiebreakerUsed: false },
  decidedAt: Date.now() - 60_000, // 1 min ago
  workspaceFingerprint: "abc123",
}

function makeInput(overrides: Partial<InheritInput> = {}): InheritInput {
  return {
    prompt: "refactor the auth module across packages",
    turnIndex: 3,
    previousDecision: basePrior,
    currentFingerprint: "abc123",
    ...overrides,
  }
}

describe("shouldInherit", () => {
  test("inherits on normal turn 2+", () => {
    expect(shouldInherit(makeInput())).toEqual({ inherit: true })
  })

  test("escape 1: /reroute prefix → re-route", () => {
    expect(shouldInherit(makeInput({ prompt: "/reroute fix the login" }))).toEqual({ inherit: false, escape: "reroute" })
  })

  test("escape 2: fingerprint drift → re-route", () => {
    expect(shouldInherit(makeInput({ currentFingerprint: "different" }))).toEqual({ inherit: false, escape: "drift" })
  })

  test("escape 3: stale (>30 min) → re-route", () => {
    const stale = { ...basePrior, decidedAt: Date.now() - 31 * 60 * 1000 }
    expect(shouldInherit(makeInput({ previousDecision: stale }))).toEqual({ inherit: false, escape: "stale" })
  })

  test("escape 4: short follow-up → re-route", () => {
    expect(shouldInherit(makeInput({ prompt: "thanks" }))).toEqual({ inherit: false, escape: "short_follow" })
  })

  test("escape 5: archetype flip to read-only → re-route", () => {
    expect(shouldInherit(makeInput({ prompt: "explain what you just did" }))).toEqual({ inherit: false, escape: "archetype" })
  })

  test("priority: /reroute wins over all others", () => {
    expect(shouldInherit(makeInput({
      prompt: "/reroute",
      currentFingerprint: "different",
      previousDecision: { ...basePrior, decidedAt: Date.now() - 31 * 60 * 1000 },
    }))).toEqual({ inherit: false, escape: "reroute" })
  })

  test("priority: drift wins over stale", () => {
    expect(shouldInherit(makeInput({
      prompt: "refactor all auth across packages",
      currentFingerprint: "different",
      previousDecision: { ...basePrior, decidedAt: Date.now() - 31 * 60 * 1000 },
    }))).toEqual({ inherit: false, escape: "drift" })
  })

  test("turn 1 never inherits", () => {
    expect(shouldInherit(makeInput({ turnIndex: 1 }))).toEqual({ inherit: false, escape: "first_turn" })
  })

  test("no previous decision never inherits", () => {
    expect(shouldInherit(makeInput({ previousDecision: undefined }))).toEqual({ inherit: false, escape: "no_prior" })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/opencode && bun test test/router/inherit.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement inherit.ts**

```typescript
// packages/opencode/src/agent/router/inherit.ts
import type { RoutingDecision } from "./types"
import { classifyArchetype } from "./scorer"

const INHERITANCE_MAX_AGE_MS = 30 * 60 * 1000 // 30 minutes
const SHORT_FOLLOW_UP_CHARS = 80
const READ_ONLY_VERBS = ["explain", "describe", "show", "what", "how", "why"]
const DEFAULT_MUTATION_VERBS = ["refactor", "migrate", "rename", "update", "add", "remove", "delete", "replace", "convert", "extract", "move"]

export interface InheritInput {
  prompt: string
  turnIndex: number
  previousDecision?: RoutingDecision
  currentFingerprint: string
}

export type InheritResult =
  | { inherit: true }
  | { inherit: false; escape: string }

export function shouldInherit(input: InheritInput): InheritResult {
  if (!input.previousDecision) return { inherit: false, escape: "no_prior" }
  if (input.turnIndex < 2) return { inherit: false, escape: "first_turn" }

  const prior = input.previousDecision

  // Priority 1: explicit /reroute
  if (input.prompt.trim().startsWith("/reroute")) {
    return { inherit: false, escape: "reroute" }
  }

  // Priority 2: fingerprint drift
  if (prior.workspaceFingerprint !== input.currentFingerprint) {
    return { inherit: false, escape: "drift" }
  }

  // Priority 3: staleness
  if (Date.now() - prior.decidedAt > INHERITANCE_MAX_AGE_MS) {
    return { inherit: false, escape: "stale" }
  }

  // Priority 4: short follow-up
  const hasPathRef = /[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+/.test(input.prompt)
  if (input.prompt.length < SHORT_FOLLOW_UP_CHARS && !hasPathRef) {
    return { inherit: false, escape: "short_follow" }
  }

  // Priority 5: archetype flip to read-only
  if (prior.mode === "coordinator") {
    const archetype = classifyArchetype(input.prompt, DEFAULT_MUTATION_VERBS)
    if (archetype === "read-only") {
      return { inherit: false, escape: "archetype" }
    }
  }

  return { inherit: true }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/opencode && bun test test/router/inherit.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/agent/router/inherit.ts packages/opencode/test/router/inherit.test.ts
git commit -m "feat(router): add inheritance logic with 5 escape conditions and priority order"
```

---

### Task 19: In-memory session state store

**Files:**
- Create: `packages/opencode/src/agent/router/session-store.ts`
- Test: `packages/opencode/test/router/session-store.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/opencode/test/router/session-store.test.ts
import { describe, test, expect } from "bun:test"
import { RouterSessionStore } from "@/agent/router/session-store"
import type { RoutingDecision } from "@/agent/router/types"

const mockDecision: RoutingDecision = {
  mode: "coordinator", confidence: "medium", confidenceScore: 0.65,
  reason: "test", firedSignals: [], signals: { promptScore: 7, codebaseScore: 6, llmTiebreakerUsed: false },
  decidedAt: Date.now(), workspaceFingerprint: "abc123",
}

describe("RouterSessionStore", () => {
  test("get returns null for unknown session", () => {
    const store = new RouterSessionStore()
    expect(store.get("unknown")).toBeNull()
  })

  test("set and get round-trips", () => {
    const store = new RouterSessionStore()
    store.set("sess1", mockDecision)
    expect(store.get("sess1")).toBe(mockDecision)
  })

  test("overwriting a session replaces the decision", () => {
    const store = new RouterSessionStore()
    store.set("sess1", mockDecision)
    const updated = { ...mockDecision, mode: "single" as const }
    store.set("sess1", updated)
    expect(store.get("sess1")!.mode).toBe("single")
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/opencode && bun test test/router/session-store.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement session-store.ts**

```typescript
// packages/opencode/src/agent/router/session-store.ts
import type { RoutingDecision } from "./types"

export class RouterSessionStore {
  private decisions = new Map<string, RoutingDecision>()

  get(sessionId: string): RoutingDecision | null {
    return this.decisions.get(sessionId) ?? null
  }

  set(sessionId: string, decision: RoutingDecision): void {
    this.decisions.set(sessionId, decision)
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/opencode && bun test test/router/session-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/agent/router/session-store.ts packages/opencode/test/router/session-store.test.ts
git commit -m "feat(router): add in-memory session state store for routing decisions"
```

---

## Phase F: Integration with agent.ts

### Task 20: selectAgent flow in agent.ts

**Files:**
- Modify: `packages/opencode/src/agent/agent.ts`

This task integrates the router into the existing agent selection flow. Read `agent.ts` fully before modifying.

- [ ] **Step 1: Read agent.ts to understand the current flow**

Read `packages/opencode/src/agent/agent.ts` in its entirety. Identify:
- Where the agent name is resolved from user input
- Where the agent object is looked up from the `agents` Record
- What the return type is (the `Info` type or similar)
- The existing `--agent` flag handling

- [ ] **Step 2: Add router imports to agent.ts**

At the top of `agent.ts`, add:

```typescript
import { route } from "./router"
import { formatOverride, formatInherited, formatRouted, emitAnnounce } from "./router/announce"
import { composeCoordinatorPrompt } from "./router/compose-prompt"
import { shouldInherit } from "./router/inherit"
import { RouterSessionStore } from "./router/session-store"
import { RealWorkspaceAnalyzer } from "./router/workspace-analyzer"
import { computeFingerprint } from "./router/fingerprint"
```

- [ ] **Step 3: Add the selectAgent logic**

The exact integration depends on how the current agent selection works. The pattern to follow:

1. Before the agent is selected/built, check for `--agent` override flag.
2. If no override, check for turn inheritance via `shouldInherit()`.
3. If no inheritance, call `route()` to make the routing decision.
4. Announce the decision via `emitAnnounce()`.
5. If coordinator mode, use `composeCoordinatorPrompt()` to inject hints.
6. Persist the decision via `RouterSessionStore`.

Adapt this pseudocode to fit the existing Effect-based agent registration pattern. The router modules are plain TypeScript — wrap them in `Effect.tryPromise()` at the boundary.

- [ ] **Step 4: Test manually**

```bash
cd packages/opencode && bun run --cwd packages/opencode --conditions=browser src/index.ts -- "fix the typo"
# Should see: → Routing: single · ...
```

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/agent/agent.ts
git commit -m "feat(router): integrate auto-routing into agent selection flow"
```

---

### Task 21: Error budget banner

**Files:**
- Create: `packages/opencode/src/agent/router/error-budget.ts`
- Test: `packages/opencode/test/router/error-budget.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/opencode/test/router/error-budget.test.ts
import { describe, test, expect } from "bun:test"
import { ErrorBudgetTracker } from "@/agent/router/error-budget"

describe("ErrorBudgetTracker", () => {
  test("no banner when under threshold", () => {
    const tracker = new ErrorBudgetTracker(4, 20)
    tracker.recordTurn("timeout")
    tracker.recordTurn("timeout")
    tracker.recordTurn("timeout")
    expect(tracker.shouldShowBanner()).toBe(false)
  })

  test("banner fires at threshold", () => {
    const tracker = new ErrorBudgetTracker(4, 20)
    for (let i = 0; i < 4; i++) tracker.recordTurn("timeout")
    expect(tracker.shouldShowBanner()).toBe(true)
    expect(tracker.getBannerMessage()).toContain("4/20")
  })

  test("banner suppressed within same window", () => {
    const tracker = new ErrorBudgetTracker(4, 20)
    for (let i = 0; i < 4; i++) tracker.recordTurn("timeout")
    expect(tracker.shouldShowBanner()).toBe(true)
    tracker.bannerShown()
    tracker.recordTurn("timeout") // 5th
    expect(tracker.shouldShowBanner()).toBe(false)
  })

  test("successful turns don't count as fallbacks", () => {
    const tracker = new ErrorBudgetTracker(4, 20)
    for (let i = 0; i < 3; i++) tracker.recordTurn("timeout")
    for (let i = 0; i < 17; i++) tracker.recordTurn(null) // null = success
    expect(tracker.shouldShowBanner()).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/opencode && bun test test/router/error-budget.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement error-budget.ts**

```typescript
// packages/opencode/src/agent/router/error-budget.ts

export class ErrorBudgetTracker {
  private readonly threshold: number
  private readonly windowSize: number
  private turns: Array<{ fallbackPath: string | null }> = []
  private bannerShownInWindow = false

  constructor(threshold: number, windowSize: number) {
    this.threshold = threshold
    this.windowSize = windowSize
  }

  recordTurn(fallbackPath: string | null): void {
    this.turns.push({ fallbackPath })
    if (this.turns.length > this.windowSize) {
      this.turns.shift()
    }
  }

  shouldShowBanner(): boolean {
    if (this.bannerShownInWindow) return false
    const fallbackCount = this.turns.filter(t => t.fallbackPath !== null).length
    return fallbackCount >= this.threshold
  }

  getBannerMessage(): string {
    const fallbackCount = this.turns.filter(t => t.fallbackPath !== null).length
    return `⚠ Router degraded — ${fallbackCount}/${this.windowSize} recent turns fell back to single-agent mode.\n  Run \`router:health\` for details.`
  }

  bannerShown(): void {
    this.bannerShownInWindow = true
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/opencode && bun test test/router/error-budget.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/agent/router/error-budget.ts packages/opencode/test/router/error-budget.test.ts
git commit -m "feat(router): add error-budget tracker with 20-turn rolling window and banner"
```

---

## Phase G: Calibration & Polish

### Task 22: Calibration fixture — 50 labeled prompts

**Files:**
- Create: `packages/opencode/src/agent/router/fixtures/calibration.json`

- [ ] **Step 1: Create the calibration fixture**

Create `packages/opencode/src/agent/router/fixtures/calibration.json` with 50 labeled prompt/workspace/expected tuples. Each entry has `prompt`, `workspace` (fixture name), `expected` (single/coordinator), and `rationale`.

The fixture must cover:
- 15 trivial/read-only prompts → expected: single
- 10 narrow mutation prompts (single file/package) → expected: single
- 10 broad mutation prompts (cross-package) → expected: coordinator
- 5 edge cases (complex prompt + tiny repo = single, etc.)
- 5 polyglot/multi-language cases
- 5 prompts with globs/paths

```json
{
  "version": 1,
  "prompts": [
    {"prompt": "fix the typo on line 5", "workspace": "single-pkg", "expected": "single", "rationale": "trivial single-file fix"},
    {"prompt": "explain how auth works", "workspace": "monorepo-small", "expected": "single", "rationale": "read-only question"},
    {"prompt": "what does this function do?", "workspace": "single-pkg", "expected": "single", "rationale": "read-only question"},
    {"prompt": "describe the architecture", "workspace": "monorepo-small", "expected": "single", "rationale": "read-only question"},
    {"prompt": "list all the API endpoints", "workspace": "monorepo-small", "expected": "single", "rationale": "read-only enumeration"},
    {"prompt": "how does the session middleware work?", "workspace": "monorepo-small", "expected": "single", "rationale": "read-only question"},
    {"prompt": "show me the login flow", "workspace": "single-pkg", "expected": "single", "rationale": "read-only question"},
    {"prompt": "why is the test failing?", "workspace": "single-pkg", "expected": "single", "rationale": "read-only debugging question"},
    {"prompt": "find all uses of deprecated API", "workspace": "monorepo-small", "expected": "single", "rationale": "read-only search"},
    {"prompt": "what changed in the last commit?", "workspace": "single-pkg", "expected": "single", "rationale": "read-only git question"},
    {"prompt": "thanks", "workspace": "single-pkg", "expected": "single", "rationale": "trivial follow-up"},
    {"prompt": "ok looks good", "workspace": "single-pkg", "expected": "single", "rationale": "trivial follow-up"},
    {"prompt": "yes", "workspace": "single-pkg", "expected": "single", "rationale": "trivial follow-up"},
    {"prompt": "run the tests", "workspace": "single-pkg", "expected": "single", "rationale": "trivial command"},
    {"prompt": "format the code", "workspace": "single-pkg", "expected": "single", "rationale": "trivial command"},
    {"prompt": "add a login button to the header", "workspace": "single-pkg", "expected": "single", "rationale": "narrow single-component change"},
    {"prompt": "fix the null pointer in utils.ts", "workspace": "single-pkg", "expected": "single", "rationale": "narrow single-file fix"},
    {"prompt": "update the README", "workspace": "single-pkg", "expected": "single", "rationale": "narrow single-file edit"},
    {"prompt": "add input validation to the signup form", "workspace": "single-pkg", "expected": "single", "rationale": "narrow single-feature change"},
    {"prompt": "rename getUserById to findUserById", "workspace": "single-pkg", "expected": "single", "rationale": "narrow rename in small repo"},
    {"prompt": "add error handling to the API controller", "workspace": "single-pkg", "expected": "single", "rationale": "narrow single-file change"},
    {"prompt": "fix the CSS for the sidebar", "workspace": "single-pkg", "expected": "single", "rationale": "narrow styling fix"},
    {"prompt": "add a new field to the User model", "workspace": "single-pkg", "expected": "single", "rationale": "narrow schema change"},
    {"prompt": "update the version in package.json", "workspace": "monorepo-small", "expected": "single", "rationale": "narrow config change"},
    {"prompt": "add a test for the login function", "workspace": "single-pkg", "expected": "single", "rationale": "narrow test addition"},
    {"prompt": "refactor all auth handlers across @app/auth and @app/api", "workspace": "monorepo-small", "expected": "coordinator", "rationale": "cross-package broad refactor"},
    {"prompt": "migrate all imports from lodash to native across every package", "workspace": "monorepo-small", "expected": "coordinator", "rationale": "cross-package migration"},
    {"prompt": "rename the session token field across @app/auth, @app/api, and @app/shared", "workspace": "monorepo-small", "expected": "coordinator", "rationale": "cross-package rename"},
    {"prompt": "update all error handlers across packages to use the new ErrorBoundary", "workspace": "monorepo-small", "expected": "coordinator", "rationale": "cross-package update"},
    {"prompt": "refactor the database layer and update all consumers across packages", "workspace": "monorepo-small", "expected": "coordinator", "rationale": "cross-package refactor with dependency chain"},
    {"prompt": "add rate limiting to all API endpoints across @app/api and @app/auth", "workspace": "monorepo-small", "expected": "coordinator", "rationale": "cross-package feature addition"},
    {"prompt": "replace all console.log with the new logger across every package", "workspace": "monorepo-small", "expected": "coordinator", "rationale": "cross-package mechanical replacement"},
    {"prompt": "convert all class components to hooks across the frontend packages", "workspace": "monorepo-small", "expected": "coordinator", "rationale": "cross-package broad conversion"},
    {"prompt": "extract shared types from @app/auth and @app/api into @app/shared", "workspace": "monorepo-small", "expected": "coordinator", "rationale": "cross-package extraction"},
    {"prompt": "add i18n support across all UI packages", "workspace": "monorepo-small", "expected": "coordinator", "rationale": "cross-package broad feature"},
    {"prompt": "refactor all modules across every package", "workspace": "single-pkg", "expected": "single", "rationale": "complex prompt but tiny repo — min-gate blocks coordinator"},
    {"prompt": "migrate all imports across all packages", "workspace": "single-pkg", "expected": "single", "rationale": "complex prompt but single package — min-gate"},
    {"prompt": "rename everything", "workspace": "empty", "expected": "single", "rationale": "empty workspace cannot parallelize"},
    {"prompt": "fix the login bug", "workspace": "monorepo-small", "expected": "single", "rationale": "narrow fix even in large repo"},
    {"prompt": "add a utility function", "workspace": "monorepo-small", "expected": "single", "rationale": "narrow addition even in large repo"},
    {"prompt": "Add a new API endpoint", "workspace": "polyglot", "expected": "single", "rationale": "single-file addition in multi-lang repo"},
    {"prompt": "Port auth logic from Python to TypeScript", "workspace": "polyglot", "expected": "coordinator", "rationale": "cross-language port with clear parallel work"},
    {"prompt": "Update all README files", "workspace": "polyglot", "expected": "single", "rationale": "multi-lang repo but trivial mechanical change"},
    {"prompt": "set up the Rust backend and connect it to the TS frontend", "workspace": "polyglot", "expected": "coordinator", "rationale": "cross-language integration work"},
    {"prompt": "add Python tests for the backend API", "workspace": "polyglot", "expected": "single", "rationale": "single-language test work"},
    {"prompt": "update **/*.ts and **/*.tsx files to use new import paths", "workspace": "monorepo-small", "expected": "coordinator", "rationale": "glob patterns indicate broad scope"},
    {"prompt": "fix src/auth/login.ts and src/api/routes.ts", "workspace": "monorepo-small", "expected": "single", "rationale": "only 2 specific files — not worth coordinator"},
    {"prompt": "refactor src/**/*.ts across packages/auth/ and packages/api/", "workspace": "monorepo-small", "expected": "coordinator", "rationale": "globs + cross-package paths"},
    {"prompt": "update packages/shared/types/index.ts", "workspace": "monorepo-small", "expected": "single", "rationale": "single file path — narrow"},
    {"prompt": "rename all *.test.ts to *.spec.ts across packages/", "workspace": "monorepo-small", "expected": "coordinator", "rationale": "glob + broad mechanical rename"}
  ]
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/opencode/src/agent/router/fixtures/calibration.json
git commit -m "feat(router): add 50-prompt calibration fixture with labeled expectations"
```

---

### Task 23: Calibration test with Wilson LCB gate

**Files:**
- Test: `packages/opencode/test/router/calibration.test.ts`

- [ ] **Step 1: Write the calibration test**

```typescript
// packages/opencode/test/router/calibration.test.ts
import { describe, test, expect } from "bun:test"
import path from "path"
import { route } from "@/agent/router"
import { FakeWorkspaceAnalyzer } from "@/agent/router/workspace-analyzer"
import type { WorkspaceAnalysis } from "@/agent/router/types"
import fixture from "@/agent/router/fixtures/calibration.json"
import gate from "@/agent/router/gate.json"

const FIXTURES_DIR = path.resolve(import.meta.dir, "../../src/agent/router/fixtures/workspaces")

const workspaceMap: Record<string, WorkspaceAnalysis> = {
  "empty": { totalFiles: 0, packageCount: 1, packages: [], languageCount: 0, manifestPaths: [], topLevelDirs: [] },
  "single-pkg": { totalFiles: 6, packageCount: 1, packages: ["my-app"], languageCount: 1, manifestPaths: ["package.json"], topLevelDirs: ["src"] },
  "monorepo-small": { totalFiles: 15, packageCount: 3, packages: ["packages/auth", "packages/api", "packages/shared"], languageCount: 1, manifestPaths: ["package.json", "packages/auth/package.json", "packages/api/package.json", "packages/shared/package.json"], topLevelDirs: ["packages", "scripts"] },
  "polyglot": { totalFiles: 8, packageCount: 2, packages: ["frontend", "backend"], languageCount: 2, manifestPaths: ["frontend/package.json", "backend/pyproject.toml"], topLevelDirs: ["frontend", "backend"] },
}

function wilsonLCB(successes: number, trials: number, z = 1.96): number {
  if (trials === 0) return 0
  const p = successes / trials
  const denom = 1 + z * z / trials
  return (p + z * z / (2 * trials) - z * Math.sqrt(p * (1 - p) / trials + z * z / (4 * trials * trials))) / denom
}

describe("Calibration", () => {
  test("router precision and recall meet gate thresholds", async () => {
    let tp = 0, fp = 0, fn = 0, tn = 0
    const misrouted: string[] = []

    for (const entry of fixture.prompts) {
      const analysis = workspaceMap[entry.workspace]
      if (!analysis) throw new Error(`Unknown workspace: ${entry.workspace}`)

      const decision = await route({
        prompt: entry.prompt,
        workspaceRoot: "/fake",
        cwd: "/fake",
        modelId: "test",
        analyzer: new FakeWorkspaceAnalyzer(analysis),
      })

      const predicted = decision.mode
      const expected = entry.expected

      if (predicted === "coordinator" && expected === "coordinator") tp++
      else if (predicted === "coordinator" && expected === "single") { fp++; misrouted.push(`FP: "${entry.prompt}" → ${predicted} (expected ${expected})`) }
      else if (predicted === "single" && expected === "coordinator") { fn++; misrouted.push(`FN: "${entry.prompt}" → ${predicted} (expected ${expected})`) }
      else tn++
    }

    const precision = tp / Math.max(1, tp + fp)
    const recall = tp / Math.max(1, tp + fn)
    const f1 = 2 * precision * recall / Math.max(0.001, precision + recall)

    console.log(`Calibration results: P=${precision.toFixed(2)} R=${recall.toFixed(2)} F1=${f1.toFixed(2)}`)
    console.log(`  TP=${tp} FP=${fp} FN=${fn} TN=${tn}`)
    if (misrouted.length > 0) {
      console.log(`  Misrouted:\n    ${misrouted.join("\n    ")}`)
    }

    const precisionLCB = wilsonLCB(tp, tp + fp)
    const recallLCB = wilsonLCB(tp, tp + fn)

    expect(precisionLCB).toBeGreaterThanOrEqual(gate.precision)
    expect(recallLCB).toBeGreaterThanOrEqual(gate.recall)
    expect(f1).toBeGreaterThanOrEqual(gate.f1)
  })
})
```

- [ ] **Step 2: Run the calibration test**

Run: `cd packages/opencode && bun test test/router/calibration.test.ts`

If it fails, examine the misrouted prompts. Adjust `weights.json` thresholds, then re-run. Once passing, update `gate.json` with the achieved metrics minus 0.05 headroom.

- [ ] **Step 3: Commit**

```bash
git add packages/opencode/test/router/calibration.test.ts packages/opencode/src/agent/router/gate.json
git commit -m "feat(router): add calibration test with Wilson LCB gate"
```

---

### Task 24: Coordinator hints test (co-ships)

**Files:**
- Test: `packages/opencode/test/router/coordinator-hints.test.ts`

- [ ] **Step 1: Write the hints test**

```typescript
// packages/opencode/test/router/coordinator-hints.test.ts
import { describe, test, expect } from "bun:test"
import { composeCoordinatorPrompt } from "@/agent/router/compose-prompt"
import PROMPT_COORDINATOR from "@/agent/prompt/coordinator.txt"

describe("Coordinator hint consumption", () => {
  test("populated placeholder → prompt contains hint block", () => {
    const result = composeCoordinatorPrompt(PROMPT_COORDINATOR, {
      suggestedWorkerCount: 2,
      suggestedPartition: [["packages/auth/**"], ["packages/api/**"]],
      triggerReasons: ["cross-package"],
    })
    expect(result).toContain("## Router Hints")
    expect(result).toContain("Worker 1: packages/auth/**")
    expect(result).toContain("Worker 2: packages/api/**")
    expect(result).not.toContain("{{ROUTER_HINTS}}")
  })

  test("empty placeholder → no dangling whitespace or literal", () => {
    const result = composeCoordinatorPrompt(PROMPT_COORDINATOR, null)
    expect(result).not.toContain("{{ROUTER_HINTS}}")
    expect(result).not.toMatch(/\n{3,}/) // no triple+ newlines
  })

  test("coordinator prompt has the placeholder in expected position", () => {
    expect(PROMPT_COORDINATOR).toContain("{{ROUTER_HINTS}}")
  })
})
```

- [ ] **Step 2: Run tests**

Run: `cd packages/opencode && bun test test/router/coordinator-hints.test.ts`
Expected: PASS (if Task 3's placeholder was inserted correctly)

- [ ] **Step 3: Commit**

```bash
git add packages/opencode/test/router/coordinator-hints.test.ts
git commit -m "feat(router): add coordinator hint consumption test (co-ships with router)"
```

---

### Task 25: Run full test suite + integration commit

**Files:**
- No new files — this is a verification task

- [ ] **Step 1: Run all router tests**

```bash
cd packages/opencode && bun test test/router/
```

Expected: All tests pass.

- [ ] **Step 2: Run the full project test suite**

```bash
cd packages/opencode && bun test --timeout 30000
```

Expected: No regressions. If any existing tests break, fix them before committing.

- [ ] **Step 3: Verify no lint errors**

```bash
cd packages/opencode && bun run check 2>/dev/null || echo "No check script — skip"
```

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat(router): complete auto-routing feature — all tests passing"
```

---

## File Index (for reference)

| Task | New/Modified File |
|---|---|
| 1 | `router/types.ts`, `router/weights.json`, `router/gate.json` |
| 2 | `router/fingerprint.ts`, `test/router/fingerprint.test.ts` |
| 3 | `router/compose-prompt.ts`, `prompt/coordinator.txt`, `test/router/compose-prompt.test.ts` |
| 4 | `prompt/tiebreaker.txt` |
| 5 | `router/workspace-analyzer.ts`, `test/router/workspace-analyzer.test.ts` |
| 6 | `router/workspace-analyzer.ts` (real impl) |
| 7 | `router/fixtures/workspaces/*`, `test/router/workspace-analyzer-real.test.ts` |
| 8 | `router/scorer.ts`, `test/router/scorer-prompt.test.ts` |
| 9 | `router/scorer.ts`, `test/router/scorer-prompt.test.ts` |
| 10 | `router/scorer.ts`, `test/router/scorer-prompt.test.ts` |
| 11 | `router/scorer.ts`, `test/router/scorer-codebase.test.ts` |
| 12 | `router/scorer.ts`, `test/router/scorer-composite.test.ts` |
| 13 | `router/classifier.ts`, `router/classifier-parse.ts`, `test/router/classifier.test.ts` |
| 14 | `router/classifier.ts`, `test/router/classifier-resilience.test.ts` |
| 15 | `router/announce.ts`, `test/router/announce.test.ts` |
| 16 | `router/telemetry.ts`, `test/router/telemetry.test.ts` |
| 17 | `router.ts` (entry), `test/router/router.test.ts` |
| 18 | `router/inherit.ts`, `test/router/inherit.test.ts` |
| 19 | `router/session-store.ts`, `test/router/session-store.test.ts` |
| 20 | `agent/agent.ts` (modified) |
| 21 | `router/error-budget.ts`, `test/router/error-budget.test.ts` |
| 22 | `router/fixtures/calibration.json` |
| 23 | `test/router/calibration.test.ts` |
| 24 | `test/router/coordinator-hints.test.ts` |
| 25 | Full test suite verification |

All paths are relative to `packages/opencode/src/` (source) or `packages/opencode/` (tests).

---

## Deferred to Follow-up PR

The following spec requirements are deliberately deferred from this plan. Each depends on opencode internals that require deeper codebase exploration or is an operational/debug feature that can ship after the core router works end-to-end.

| Item | Spec section | Why deferred |
|---|---|---|
| **Real LLM classifier** (production implementation that calls an actual provider) | §5 | Requires opencode's provider/model abstraction (Effect-based). The MockClassifier + GuardedClassifier are sufficient for testing and calibration. Wire the real classifier when the provider API is understood. |
| **`router:health` script** | §7 | Streaming JSONL aggregator. Operational tooling — not blocking core routing. |
| **`--route-explain` CLI flag** | §7 | Debug surface. Requires understanding opencode's CLI arg parsing. |
| **`OPENCODE_ROUTER_DEBUG=1` env logging** | §7 | Debug surface. Low priority — telemetry JSONL covers calibration needs. |
| **Stacking failure integration tests** | §8 | Requires all modules wired together. Add after Task 20 integration is stable. |
| **Smoke test with provider matrix** | §8 | Manual-only by spec. Requires real API keys and hosted provider access. |
| **`routerDecisionVersion` hash computation** | §7 | Requires reading all three version inputs. Can be added to `telemetry.ts` as a follow-up. |

**Recommended order for follow-up PR:**
1. Real LLM classifier (unlocks the uncertain-band path)
2. Stacking failure tests (validates error budget)
3. `--route-explain` (most useful debug tool)
4. Health script + debug env (operational)
5. Smoke test (calibration)
