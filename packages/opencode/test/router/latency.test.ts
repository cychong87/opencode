import { describe, test, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { route } from "@/agent/router"
import { FakeWorkspaceAnalyzer, RealWorkspaceAnalyzer } from "@/agent/router/workspace-analyzer"
import type { WorkspaceAnalysis, RouteInput } from "@/agent/router/types"

const largeMonorepo: WorkspaceAnalysis = {
  totalFiles: 500,
  packageCount: 5,
  packages: ["@app/auth", "@app/api", "@app/shared", "@app/web", "@app/cli"],
  languageCount: 1,
  manifestPaths: ["package.json", "packages/auth/package.json", "packages/api/package.json"],
  topLevelDirs: ["packages", "scripts", "docs"],
}

function p(samples: number[], pct: number): number {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length * pct)]
}

async function measure(fn: () => Promise<unknown>): Promise<number> {
  const start = performance.now()
  await fn()
  return performance.now() - start
}

describe("Router latency — warm path (cached fake analyzer, pure heuristics)", () => {
  test("warm route() p95 < 10ms across 200 calls", async () => {
    const analyzer = new FakeWorkspaceAnalyzer(largeMonorepo)
    const base: RouteInput = {
      prompt: "refactor all auth handlers across @app/auth and @app/api",
      workspaceRoot: "/fake",
      cwd: "/fake",
      modelId: "test",
      analyzer,
    }

    // Warm-up (first 5 calls may be slightly slower due to V8 JIT warmup)
    for (let i = 0; i < 5; i++) await route(base)

    // Measure 200 calls
    const samples: number[] = []
    for (let i = 0; i < 200; i++) {
      samples.push(await measure(() => route(base)))
    }

    const p50 = p(samples, 0.5)
    const p95 = p(samples, 0.95)
    const p99 = p(samples, 0.99)
    console.log(`  warm latency: p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms p99=${p99.toFixed(2)}ms`)

    expect(p95).toBeLessThan(10)
  })

  test("warm route() with varied prompt lengths still < 10ms p95", async () => {
    const analyzer = new FakeWorkspaceAnalyzer(largeMonorepo)
    const prompts = [
      "fix typo",
      "refactor auth across @app/auth and @app/api",
      "migrate all imports from lodash to native across @app/auth, @app/api, @app/shared, @app/web, @app/cli and also rename the session token field and add error boundaries and convert class components to hooks everywhere",
    ]
    // Warm up
    for (const prompt of prompts) await route({ ...makeBase(analyzer), prompt })

    const samples: number[] = []
    for (let i = 0; i < 100; i++) {
      for (const prompt of prompts) {
        samples.push(await measure(() => route({ ...makeBase(analyzer), prompt })))
      }
    }
    const p95 = p(samples, 0.95)
    console.log(`  varied-prompt warm latency: p95=${p95.toFixed(2)}ms (${samples.length} samples)`)
    expect(p95).toBeLessThan(10)
  })
})

function makeBase(analyzer: FakeWorkspaceAnalyzer | RealWorkspaceAnalyzer): RouteInput {
  return {
    prompt: "placeholder",
    workspaceRoot: "/fake",
    cwd: "/fake",
    modelId: "test",
    analyzer,
  }
}

describe("Router latency — cold path (real analyzer, first call)", () => {
  let tmpWorkspace: string

  async function setupTmpWorkspace(fileCount: number): Promise<void> {
    tmpWorkspace = await fs.mkdtemp(path.join(import.meta.dir, "tmp-latency-"))
    await fs.writeFile(path.join(tmpWorkspace, "package.json"), '{"name":"root"}')
    // Create some packages
    for (const pkg of ["auth", "api", "shared"]) {
      await fs.mkdir(path.join(tmpWorkspace, "packages", pkg, "src"), { recursive: true })
      await fs.writeFile(
        path.join(tmpWorkspace, "packages", pkg, "package.json"),
        JSON.stringify({ name: `@app/${pkg}` }),
      )
    }
    // Seed source files up to fileCount
    const perPkg = Math.floor((fileCount - 1) / 3)
    for (const pkg of ["auth", "api", "shared"]) {
      for (let i = 0; i < perPkg; i++) {
        await fs.writeFile(path.join(tmpWorkspace, "packages", pkg, "src", `file${i}.ts`), "")
      }
    }
  }

  test("cold route() p95 < 1500ms on ~200-file workspace (20 trials)", async () => {
    await setupTmpWorkspace(200)
    try {
      const samples: number[] = []
      for (let i = 0; i < 20; i++) {
        const analyzer = new RealWorkspaceAnalyzer() // fresh instance = cold
        samples.push(
          await measure(() =>
            route({
              prompt: "refactor all auth handlers across @app/auth and @app/api",
              workspaceRoot: tmpWorkspace,
              cwd: tmpWorkspace,
              modelId: "test",
              analyzer,
            }),
          ),
        )
      }
      const p50 = p(samples, 0.5)
      const p95 = p(samples, 0.95)
      console.log(`  cold latency (~200 files): p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms`)
      expect(p95).toBeLessThan(1500)
    } finally {
      await fs.rm(tmpWorkspace, { recursive: true }).catch(() => {})
    }
  })

  test("cold route() p95 < 3000ms on ~1000-file workspace (10 trials)", async () => {
    await setupTmpWorkspace(1000)
    try {
      const samples: number[] = []
      for (let i = 0; i < 10; i++) {
        const analyzer = new RealWorkspaceAnalyzer()
        samples.push(
          await measure(() =>
            route({
              prompt: "refactor all auth handlers across @app/auth and @app/api",
              workspaceRoot: tmpWorkspace,
              cwd: tmpWorkspace,
              modelId: "test",
              analyzer,
            }),
          ),
        )
      }
      const p95 = p(samples, 0.95)
      console.log(`  cold latency (~1000 files): p95=${p95.toFixed(2)}ms`)
      expect(p95).toBeLessThan(3000)
    } finally {
      await fs.rm(tmpWorkspace, { recursive: true }).catch(() => {})
    }
  })

  test("warm reuse on cached RealAnalyzer p95 < 10ms (same analyzer instance)", async () => {
    await setupTmpWorkspace(200)
    try {
      const analyzer = new RealWorkspaceAnalyzer()
      // First call primes the cache
      await route({
        prompt: "warmup",
        workspaceRoot: tmpWorkspace,
        cwd: tmpWorkspace,
        modelId: "test",
        analyzer,
      })

      const samples: number[] = []
      for (let i = 0; i < 100; i++) {
        samples.push(
          await measure(() =>
            route({
              prompt: "refactor all auth across @app/auth and @app/api",
              workspaceRoot: tmpWorkspace,
              cwd: tmpWorkspace,
              modelId: "test",
              analyzer, // same instance — cache hit
            }),
          ),
        )
      }
      const p95 = p(samples, 0.95)
      console.log(`  real analyzer, warm cache: p95=${p95.toFixed(2)}ms`)
      expect(p95).toBeLessThan(10)
    } finally {
      await fs.rm(tmpWorkspace, { recursive: true }).catch(() => {})
    }
  })
})
