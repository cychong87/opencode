import { describe, test, expect } from "bun:test"
import { formatOverride, formatInherited, formatRouted, emitAnnounce } from "@/agent/router/announce"
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
  fallbackPath: null,
}

describe("formatOverride", () => {
  test("outputs fixed format", () => {
    expect(formatOverride("coordinator")).toBe("→ Routing: coordinator (manual override)")
  })

  test("works with other agent names", () => {
    expect(formatOverride("plan")).toBe("→ Routing: plan (manual override)")
  })
})

describe("formatInherited", () => {
  test("outputs inherited format", () => {
    expect(formatInherited(mockDecision)).toBe("→ Routing: coordinator · inherited from previous turn")
  })

  test("works with single mode", () => {
    const single = { ...mockDecision, mode: "single" as const }
    expect(formatInherited(single)).toBe("→ Routing: single · inherited from previous turn")
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

describe("emitAnnounce", () => {
  test("uses tuiEmit when provided", () => {
    let captured: { message: string; variant: string } | null = null
    const tuiEmit = (message: string, variant: "info" | "warning") => {
      captured = { message, variant }
    }
    emitAnnounce("test message", { tuiEmit })
    expect(captured).not.toBeNull()
    expect(captured!.message).toBe("test message")
    expect(captured!.variant).toBe("info")
  })
})
