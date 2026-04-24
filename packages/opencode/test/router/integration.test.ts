import { describe, test, expect, beforeEach, beforeAll, afterAll } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { selectAgentMode, sessionStore, errorBudget } from "@/agent/router/integration"
import { FakeWorkspaceAnalyzer } from "@/agent/router/workspace-analyzer"
import { sha256Hex } from "@/agent/router/version"
import type { WorkspaceAnalysis } from "@/agent/router/types"

// Real temp directory with a manifest so computeFingerprint returns a stable hash
// (integration tests need inheritance to work, which requires fingerprint stability)
let tmpWorkspace: string
beforeAll(async () => {
  tmpWorkspace = await fs.mkdtemp(path.join(import.meta.dir, "tmp-integ-"))
  await fs.writeFile(path.join(tmpWorkspace, "package.json"), "{}")
  await fs.mkdir(path.join(tmpWorkspace, "src"))
})
afterAll(async () => {
  await fs.rm(tmpWorkspace, { recursive: true }).catch(() => {})
})

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

const captured: string[] = []
const tuiEmit = (msg: string) => { captured.push(msg) }

function makeInput(prompt: string, analysis: WorkspaceAnalysis, overrides: Record<string, any> = {}) {
  return {
    prompt,
    workspaceRoot: tmpWorkspace,
    cwd: tmpWorkspace,
    modelId: "test",
    sessionId: "test-session",
    turnIndex: 1,
    analyzer: new FakeWorkspaceAnalyzer(analysis),
    announceOpts: { tuiEmit },
    suppressTelemetry: true,
    ...overrides,
  }
}

beforeEach(() => {
  captured.length = 0
  sessionStore.reset()
  errorBudget.reset()
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

  test("persists decision and turn 2 inherits", async () => {
    // Turn 1: route normally
    await selectAgentMode(makeInput(
      "refactor all auth handlers across @app/auth and @app/api",
      largeMonorepo,
      { sessionId: "inherit-sess", turnIndex: 1 },
    ))
    const stored = sessionStore.get("inherit-sess")
    expect(stored).not.toBeNull()

    // Turn 2: inherits the previous coordinator decision
    captured.length = 0
    const result = await selectAgentMode(makeInput(
      "now update the shared types too across @app/auth and @app/shared",
      largeMonorepo,
      { sessionId: "inherit-sess", turnIndex: 2 },
    ))
    expect(result.mode).toBe(stored!.mode)
    expect(captured[0]).toContain("inherited from previous turn")
  })

  test("escape /reroute breaks inheritance", async () => {
    // Turn 1
    await selectAgentMode(makeInput("refactor all across @app/auth and @app/api", largeMonorepo, {
      sessionId: "reroute-sess", turnIndex: 1,
    }))

    // Turn 2 with /reroute
    captured.length = 0
    const result = await selectAgentMode(makeInput("/reroute fix the typo", smallWorkspace, {
      sessionId: "reroute-sess", turnIndex: 2,
    }))
    // Should NOT inherit — should route fresh
    expect(captured[0]).toContain("→ Routing:")
    expect(captured[0]).not.toContain("inherited")
  })

  test("telemetry record is written when suppressTelemetry is false", async () => {
    const result = await selectAgentMode(makeInput("fix the typo", smallWorkspace, {
      suppressTelemetry: false,  // explicitly enable
      sessionId: "telemetry-test",
    }))
    expect(result.mode).toBe("single")
    // Check that the daily JSONL file was created
    const today = new Date().toISOString().slice(0, 10)
    const file = path.join(tmpWorkspace, ".opencode", `router-decisions-${today}.jsonl`)
    const content = await fs.readFile(file, "utf-8")
    expect(content).toContain('"source":"routed"')
    expect(content).toContain('"routerDecisionVersion":')
    expect(content).toContain('"promptSha":')
  })

  // G.1 — Privacy: a recognizable canary in the prompt must never reach disk verbatim,
  // while its SHA-256 prefix must. Protects against accidental regressions where a
  // future code path adds a field that includes the raw prompt content.
  test("privacy: telemetry never writes raw prompt content (G.1)", async () => {
    const canary = "SECRET_CANARY_STRING_xyz987_must_not_appear_in_telemetry"
    const prompt = `please fix the typo ${canary} on line 5`

    await selectAgentMode(makeInput(prompt, smallWorkspace, {
      suppressTelemetry: false,
      sessionId: "privacy-test",
    }))

    const today = new Date().toISOString().slice(0, 10)
    const file = path.join(tmpWorkspace, ".opencode", `router-decisions-${today}.jsonl`)
    const content = await fs.readFile(file, "utf-8")

    // The canary must not appear anywhere — neither the full string nor a distinctive substring
    expect(content).not.toContain(canary)
    expect(content).not.toContain("SECRET_CANARY_STRING")

    // The hash prefix (first 16 hex chars) must appear — confirms the privacy-preserving
    // identifier is being written as designed
    const expectedSha = sha256Hex(prompt).slice(0, 16)
    expect(content).toContain(expectedSha)
  })

  test("error budget banner fires after multiple fallbacks", async () => {
    const crashingAnalyzer = {
      analyze: async () => { throw new Error("crash") },
    }
    // Fire 4 crashing turns to trigger the 4/20 threshold
    for (let i = 0; i < 4; i++) {
      captured.length = 0
      await selectAgentMode({
        prompt: "test", workspaceRoot: tmpWorkspace, cwd: tmpWorkspace,
        modelId: "test", sessionId: `budget-${i}`, turnIndex: 1,
        analyzer: crashingAnalyzer,
        announceOpts: { tuiEmit },
        suppressTelemetry: true,
      })
    }
    // The 4th turn should have triggered the banner
    const bannerMessages = captured.filter(m => m.includes("⚠"))
    expect(bannerMessages.length).toBeGreaterThanOrEqual(1)
    expect(bannerMessages[0]).toContain("Router degraded")
  })
})
