import { describe, test, expect } from "bun:test"
import {
  getFaultMode,
  withFaultyAnalyzer,
  withFaultyClassifier,
} from "@/agent/router/fault-inject"
import type { WorkspaceAnalyzer, LLMClassifier } from "@/agent/router/types"

const noopAnalyzer: WorkspaceAnalyzer = {
  analyze: async () => ({
    totalFiles: 10, packageCount: 1, packages: [], languageCount: 1,
    manifestPaths: [], topLevelDirs: [],
  }),
}
const noopClassifier: LLMClassifier = {
  classify: async () => ({ decision: "single", confidence: "high", reason: "ok" }),
}

describe("getFaultMode", () => {
  test("returns null when OPENCODE_ROUTER_DEBUG is not set", () => {
    expect(getFaultMode({ OPENCODE_ROUTER_FAULT_INJECT: "analyzer-fail" })).toBeNull()
  })

  test("returns null when OPENCODE_ROUTER_DEBUG is not exactly '1'", () => {
    expect(getFaultMode({ OPENCODE_ROUTER_DEBUG: "true", OPENCODE_ROUTER_FAULT_INJECT: "analyzer-fail" })).toBeNull()
    expect(getFaultMode({ OPENCODE_ROUTER_DEBUG: "", OPENCODE_ROUTER_FAULT_INJECT: "analyzer-fail" })).toBeNull()
    expect(getFaultMode({ OPENCODE_ROUTER_DEBUG: "0", OPENCODE_ROUTER_FAULT_INJECT: "analyzer-fail" })).toBeNull()
  })

  test("returns null when OPENCODE_ROUTER_FAULT_INJECT is missing", () => {
    expect(getFaultMode({ OPENCODE_ROUTER_DEBUG: "1" })).toBeNull()
  })

  test("returns null for invalid mode values", () => {
    expect(getFaultMode({ OPENCODE_ROUTER_DEBUG: "1", OPENCODE_ROUTER_FAULT_INJECT: "bogus" })).toBeNull()
    expect(getFaultMode({ OPENCODE_ROUTER_DEBUG: "1", OPENCODE_ROUTER_FAULT_INJECT: "" })).toBeNull()
  })

  test("returns the mode when both env vars are set to valid values", () => {
    expect(getFaultMode({ OPENCODE_ROUTER_DEBUG: "1", OPENCODE_ROUTER_FAULT_INJECT: "analyzer-fail" })).toBe("analyzer-fail")
    expect(getFaultMode({ OPENCODE_ROUTER_DEBUG: "1", OPENCODE_ROUTER_FAULT_INJECT: "classifier-timeout" })).toBe("classifier-timeout")
    expect(getFaultMode({ OPENCODE_ROUTER_DEBUG: "1", OPENCODE_ROUTER_FAULT_INJECT: "classifier-malformed" })).toBe("classifier-malformed")
  })
})

describe("withFaultyAnalyzer", () => {
  test("passes through when no fault mode set", () => {
    const wrapped = withFaultyAnalyzer(noopAnalyzer, null)
    expect(wrapped).toBe(noopAnalyzer)
  })

  test("passes through when mode targets classifier, not analyzer", () => {
    expect(withFaultyAnalyzer(noopAnalyzer, "classifier-timeout")).toBe(noopAnalyzer)
    expect(withFaultyAnalyzer(noopAnalyzer, "classifier-malformed")).toBe(noopAnalyzer)
  })

  test("returns a throwing analyzer when analyzer-fail is set", async () => {
    const faulty = withFaultyAnalyzer(noopAnalyzer, "analyzer-fail")
    expect(faulty).not.toBe(noopAnalyzer)
    await expect(faulty.analyze("/any")).rejects.toThrow(/analyzer-fail/)
  })
})

describe("withFaultyClassifier", () => {
  test("passes through when no fault mode set", () => {
    const wrapped = withFaultyClassifier(noopClassifier, null)
    expect(wrapped).toBe(noopClassifier)
  })

  test("passes through when mode targets analyzer, not classifier", () => {
    expect(withFaultyClassifier(noopClassifier, "analyzer-fail")).toBe(noopClassifier)
  })

  test("passes through undefined when no fault mode set", () => {
    expect(withFaultyClassifier(undefined, null)).toBeUndefined()
  })

  test("returns timeout-shaped thrower for classifier-timeout", async () => {
    const faulty = withFaultyClassifier(noopClassifier, "classifier-timeout")
    expect(faulty).not.toBe(noopClassifier)
    const err = await faulty!.classify({
      prompt: "x", firedSignalNames: [], timeoutMs: 1000,
      heuristicSummary: { taskArchetype: "trivial", fileCount: 0, packageCount: 1 },
    }).then(() => null, (e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    // Error message must contain "timeout" so GuardedClassifier labels it correctly
    expect((err as Error).message.toLowerCase()).toContain("timeout")
  })

  test("returns malformed-shaped thrower for classifier-malformed", async () => {
    const faulty = withFaultyClassifier(noopClassifier, "classifier-malformed")
    expect(faulty).not.toBe(noopClassifier)
    const err = await faulty!.classify({
      prompt: "x", firedSignalNames: [], timeoutMs: 1000,
      heuristicSummary: { taskArchetype: "trivial", fileCount: 0, packageCount: 1 },
    }).then(() => null, (e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    // Error message must contain "malformed" so GuardedClassifier labels it correctly
    expect((err as Error).message.toLowerCase()).toContain("malformed")
  })

  test("synthesizes a faulty classifier even when real is undefined (timeout mode)", async () => {
    const faulty = withFaultyClassifier(undefined, "classifier-timeout")
    expect(faulty).toBeDefined()
    await expect(faulty!.classify({
      prompt: "x", firedSignalNames: [], timeoutMs: 1000,
      heuristicSummary: { taskArchetype: "trivial", fileCount: 0, packageCount: 1 },
    })).rejects.toThrow(/timeout/)
  })
})
