import { describe, test, expect } from "bun:test"
import { shouldInherit } from "@/agent/router/inherit"
import type { InheritInput } from "@/agent/router/inherit"
import type { RoutingDecision } from "@/agent/router/types"

const basePrior: RoutingDecision = {
  mode: "coordinator", confidence: "medium", confidenceScore: 0.65,
  reason: "test", firedSignals: [], signals: { promptScore: 7, codebaseScore: 6, llmTiebreakerUsed: false },
  decidedAt: Date.now() - 60_000, // 1 min ago
  workspaceFingerprint: "abc123",
  fallbackPath: null,
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

  test("no previous decision → no_prior", () => {
    expect(shouldInherit(makeInput({ previousDecision: undefined }))).toEqual({ inherit: false, escape: "no_prior" })
  })

  test("turn 1 → first_turn", () => {
    expect(shouldInherit(makeInput({ turnIndex: 1 }))).toEqual({ inherit: false, escape: "first_turn" })
  })

  test("escape 1: /reroute prefix → reroute", () => {
    expect(shouldInherit(makeInput({ prompt: "/reroute fix the login" }))).toEqual({ inherit: false, escape: "reroute" })
  })

  test("escape 2: fingerprint drift → drift", () => {
    expect(shouldInherit(makeInput({ currentFingerprint: "different" }))).toEqual({ inherit: false, escape: "drift" })
  })

  test("escape 3: stale (>30 min) → stale", () => {
    const stale = { ...basePrior, decidedAt: Date.now() - 31 * 60 * 1000 }
    expect(shouldInherit(makeInput({ previousDecision: stale }))).toEqual({ inherit: false, escape: "stale" })
  })

  test("escape 4: short follow-up → short_follow", () => {
    expect(shouldInherit(makeInput({ prompt: "thanks" }))).toEqual({ inherit: false, escape: "short_follow" })
  })

  test("escape 4: short but with file path → inherits", () => {
    expect(shouldInherit(makeInput({ prompt: "fix src/auth.ts" }))).toEqual({ inherit: true })
  })

  test("escape 5: archetype flip to read-only → archetype", () => {
    expect(shouldInherit(makeInput({ prompt: "explain what you just did" }))).toEqual({ inherit: false, escape: "archetype" })
  })

  test("escape 5: archetype flip only applies when prior was coordinator", () => {
    const singlePrior = { ...basePrior, mode: "single" as const }
    expect(shouldInherit(makeInput({ previousDecision: singlePrior, prompt: "explain what you did" }))).toEqual({ inherit: true })
  })

  // Priority tests
  test("priority: /reroute wins over drift", () => {
    expect(shouldInherit(makeInput({
      prompt: "/reroute",
      currentFingerprint: "different",
    }))).toEqual({ inherit: false, escape: "reroute" })
  })

  test("priority: drift wins over stale", () => {
    const stale = { ...basePrior, decidedAt: Date.now() - 31 * 60 * 1000 }
    expect(shouldInherit(makeInput({
      prompt: "refactor all auth across packages",
      currentFingerprint: "different",
      previousDecision: stale,
    }))).toEqual({ inherit: false, escape: "drift" })
  })

  test("priority: stale wins over short_follow", () => {
    const stale = { ...basePrior, decidedAt: Date.now() - 31 * 60 * 1000 }
    expect(shouldInherit(makeInput({
      prompt: "ok",
      previousDecision: stale,
    }))).toEqual({ inherit: false, escape: "stale" })
  })
})
