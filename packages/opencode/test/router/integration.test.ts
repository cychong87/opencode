import { describe, test, expect, beforeEach } from "bun:test"
import { selectAgentMode, sessionStore, errorBudget } from "@/agent/router/integration"
import { FakeWorkspaceAnalyzer } from "@/agent/router/workspace-analyzer"
import { MockClassifier } from "@/agent/router/classifier"
import type { WorkspaceAnalysis } from "@/agent/router/types"

const largeMonorepo: WorkspaceAnalysis = {
  totalFiles: 500, packageCount: 5,
  packages: ["@app/auth", "@app/api", "@app/shared", "@app/web", "@app/cli"],
  languageCount: 1, manifestPaths: ["package.json"],
  topLevelDirs: ["packages", "scripts", "docs"],
}

const smallWorkspace: WorkspaceAnalysis = {
  totalFiles: 10, packageCount: 1, packages: ["my-app"],
  languageCount: 1, manifestPaths: ["package.json"], topLevelDirs: ["src"],
}

// Capture announce output instead of writing to stderr
const captured: string[] = []
const tuiEmit = (msg: string) => { captured.push(msg) }

function makeInput(prompt: string, analysis: WorkspaceAnalysis, overrides: Record<string, any> = {}) {
  return {
    prompt,
    workspaceRoot: "/fake",
    cwd: "/fake",
    modelId: "test",
    sessionId: "test-session",
    turnIndex: 1,
    analyzer: new FakeWorkspaceAnalyzer(analysis),
    announceOpts: { tuiEmit },
    ...overrides,
  }
}

beforeEach(() => {
  captured.length = 0
})

describe("selectAgentMode", () => {
  test("explicit coordinator override → coordinator with hints", async () => {
    const result = await selectAgentMode(makeInput("anything", largeMonorepo, {
      userOverride: "coordinator",
    }))
    expect(result.mode).toBe("coordinator")
    expect(result.agentName).toBe("coordinator")
    expect(result.decision).toBeNull()
    expect(captured[0]).toContain("manual override")
  })

  test("explicit non-coordinator override → other", async () => {
    const result = await selectAgentMode(makeInput("anything", smallWorkspace, {
      userOverride: "plan",
    }))
    expect(result.mode).toBe("other")
    expect(result.agentName).toBe("plan")
    expect(captured[0]).toContain("plan")
  })

  test("normal routing → single for trivial prompt", async () => {
    const result = await selectAgentMode(makeInput("fix the typo", smallWorkspace))
    expect(result.mode).toBe("single")
    expect(result.agentName).toBe("default")
    expect(result.decision).not.toBeNull()
    expect(captured.length).toBeGreaterThan(0)
  })

  test("normal routing → coordinator for cross-package refactor", async () => {
    const result = await selectAgentMode(makeInput(
      "refactor all auth handlers across @app/auth and @app/api",
      largeMonorepo,
    ))
    expect(result.mode).toBe("coordinator")
    expect(result.agentName).toBe("coordinator")
    expect(result.decision).not.toBeNull()
  })

  test("announces routing decision", async () => {
    await selectAgentMode(makeInput("fix the typo", smallWorkspace))
    expect(captured.length).toBe(1)
    expect(captured[0]).toContain("→ Routing:")
  })

  test("persists decision for inheritance", async () => {
    await selectAgentMode(makeInput("fix the typo", smallWorkspace, {
      sessionId: "inherit-test",
      turnIndex: 1,
    }))
    const stored = sessionStore.get("inherit-test")
    expect(stored).not.toBeNull()
    expect(stored!.mode).toBe("single")
  })
})
