import { describe, test, expect } from "bun:test"
import { composeCoordinatorPrompt } from "@/agent/router/compose-prompt"
import PROMPT_COORDINATOR from "@/agent/prompt/coordinator.txt"

describe("Coordinator hint consumption", () => {
  test("coordinator.txt has the {{ROUTER_HINTS}} placeholder", () => {
    expect(PROMPT_COORDINATOR).toContain("{{ROUTER_HINTS}}")
  })

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
    // The hint block should be between workflow and anti-patterns
    expect(result).toContain("You are a team coordinator")
    expect(result).toContain("ANTI-PATTERNS")
  })

  test("empty placeholder → no dangling whitespace or literal", () => {
    const result = composeCoordinatorPrompt(PROMPT_COORDINATOR, null)
    expect(result).not.toContain("{{ROUTER_HINTS}}")
    expect(result).not.toMatch(/\n{3,}/)  // no triple+ newlines
    expect(result).toContain("You are a team coordinator")
    expect(result).toContain("ANTI-PATTERNS")
  })

  test("hints are advisory — contain override language", () => {
    const result = composeCoordinatorPrompt(PROMPT_COORDINATOR, {
      suggestedWorkerCount: 3,
      suggestedPartition: [["a/**"], ["b/**"], ["c/**"]],
      triggerReasons: ["test"],
    })
    expect(result).toContain("advisory")
    expect(result).toContain("override if you disagree")
  })
})
