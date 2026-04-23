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

  test("handles empty triggerReasons without crashing", () => {
    const hints: HintBlock = {
      suggestedWorkerCount: 1,
      triggerReasons: [],
    }
    const block = renderHintBlock(hints)
    expect(block).toContain("Suggested worker count: 1")
    expect(block).not.toContain("Signals that triggered")
  })
})
