import { describe, test, expect } from "bun:test"
import { MockClassifier } from "@/agent/router/classifier"
import { parseClassifierOutput } from "@/agent/router/classifier-parse"

describe("MockClassifier", () => {
  test("returns configured output", async () => {
    const mock = new MockClassifier({ decision: "coordinator", confidence: "high", reason: "multi-package" })
    const result = await mock.classify({
      prompt: "test", firedSignalNames: [], timeoutMs: 1000,
      heuristicSummary: { taskArchetype: "mutating-broad", fileCount: 100, packageCount: 3 },
    })
    expect(result.decision).toBe("coordinator")
    expect(result.confidence).toBe("high")
  })
})

describe("parseClassifierOutput", () => {
  test("parses valid JSON", () => {
    const raw = '{"decision": "coordinator", "confidence": "high", "reason": "multi-package refactor"}'
    const result = parseClassifierOutput(raw, "json")
    expect(result.decision).toBe("coordinator")
    expect(result.confidence).toBe("high")
    expect(result.reason).toBe("multi-package refactor")
  })

  test("parses regex format", () => {
    const raw = "DECISION: coordinator\nCONFIDENCE: high\nREASON: multi-package refactor"
    const result = parseClassifierOutput(raw, "regex")
    expect(result.decision).toBe("coordinator")
    expect(result.confidence).toBe("high")
  })

  test("truncates reason to 80 chars", () => {
    const longReason = "a".repeat(100)
    const raw = `{"decision": "single", "confidence": "low", "reason": "${longReason}"}`
    const result = parseClassifierOutput(raw, "json")
    expect(result.reason.length).toBeLessThanOrEqual(80)
  })

  test("throws on missing decision field", () => {
    expect(() => parseClassifierOutput('{"confidence": "high"}', "json")).toThrow()
  })

  test("throws on invalid decision value", () => {
    expect(() => parseClassifierOutput('{"decision": "maybe", "confidence": "high", "reason": "x"}', "json")).toThrow()
  })

  test("throws on garbage input", () => {
    expect(() => parseClassifierOutput("hello world", "json")).toThrow()
  })

  test("json-schema mode uses same parser as json", () => {
    const raw = '{"decision": "single", "confidence": "low", "reason": "ok"}'
    const result = parseClassifierOutput(raw, "json-schema")
    expect(result.decision).toBe("single")
  })

  test("regex: case insensitive", () => {
    const raw = "decision: COORDINATOR\nconfidence: LOW\nreason: test"
    const result = parseClassifierOutput(raw, "regex")
    expect(result.decision).toBe("coordinator")
    expect(result.confidence).toBe("low")
  })

  test("json: extracts JSON from markdown fence ```json...```", () => {
    const raw = '```json\n{"decision": "coordinator", "confidence": "high", "reason": "ok"}\n```'
    const result = parseClassifierOutput(raw, "json")
    expect(result.decision).toBe("coordinator")
  })

  test("json: extracts JSON with surrounding prose", () => {
    const raw = 'Here is the classification:\n{"decision": "single", "confidence": "high", "reason": "simple"}\nHope this helps!'
    const result = parseClassifierOutput(raw, "json")
    expect(result.decision).toBe("single")
    expect(result.confidence).toBe("high")
  })

  test("json: handles bare fence without language tag", () => {
    const raw = '```\n{"decision": "single", "confidence": "low", "reason": "x"}\n```'
    const result = parseClassifierOutput(raw, "json")
    expect(result.decision).toBe("single")
  })
})
