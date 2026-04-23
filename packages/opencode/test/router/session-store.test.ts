import { describe, test, expect } from "bun:test"
import { RouterSessionStore } from "@/agent/router/session-store"
import type { RoutingDecision } from "@/agent/router/types"

const mockDecision: RoutingDecision = {
  mode: "coordinator", confidence: "medium", confidenceScore: 0.65,
  reason: "test", firedSignals: [], signals: { promptScore: 7, codebaseScore: 6, llmTiebreakerUsed: false },
  decidedAt: Date.now(), workspaceFingerprint: "abc123", fallbackPath: null,
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

  test("overwriting replaces the decision", () => {
    const store = new RouterSessionStore()
    store.set("sess1", mockDecision)
    const updated = { ...mockDecision, mode: "single" as const }
    store.set("sess1", updated)
    expect(store.get("sess1")!.mode).toBe("single")
  })

  test("different sessions are independent", () => {
    const store = new RouterSessionStore()
    store.set("sess1", mockDecision)
    const other = { ...mockDecision, mode: "single" as const }
    store.set("sess2", other)
    expect(store.get("sess1")!.mode).toBe("coordinator")
    expect(store.get("sess2")!.mode).toBe("single")
  })
})
