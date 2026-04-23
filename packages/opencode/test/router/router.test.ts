import { describe, test, expect } from "bun:test"
import { route } from "@/agent/router"
import { FakeWorkspaceAnalyzer } from "@/agent/router/workspace-analyzer"
import type { RouteInput, WorkspaceAnalysis, LLMClassifier } from "@/agent/router/types"

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

function makeInput(prompt: string, analysis: WorkspaceAnalysis, classifier?: LLMClassifier): RouteInput {
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
    expect(result.fallbackPath).toBeNull()
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

  test("returns fired signals list", async () => {
    const result = await route(makeInput(
      "refactor all auth handlers across @app/auth and @app/api",
      largeMonorepo,
    ))
    expect(result.firedSignals.length).toBeGreaterThan(0)
  })

  test("returns valid fingerprint", async () => {
    const result = await route(makeInput("fix bug", smallWorkspace))
    expect(result.workspaceFingerprint).toBeDefined()
    expect(typeof result.workspaceFingerprint).toBe("string")
  })

  test("returns decidedAt timestamp", async () => {
    const before = Date.now()
    const result = await route(makeInput("fix bug", smallWorkspace))
    expect(result.decidedAt).toBeGreaterThanOrEqual(before)
  })
})
