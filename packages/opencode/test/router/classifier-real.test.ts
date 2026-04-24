import { describe, test, expect } from "bun:test"
import { RealClassifier } from "@/agent/router/classifier-real"
import type { ClassifierInput } from "@/agent/router/types"

const baseInput: ClassifierInput = {
  prompt: "refactor all auth handlers",
  firedSignalNames: ["P3_scope_keywords", "C2_package_count"],
  heuristicSummary: { taskArchetype: "mutating-broad", fileCount: 200, packageCount: 3 },
  timeoutMs: 3000,
}

describe("RealClassifier", () => {
  test("parses valid JSON response", async () => {
    const fakeModel = {
      // AI SDK calls this under the hood — we fake the whole model interface
      // just enough to pass through generateText.
    } as any
    // We mock generateText by using a model that throws — we test the parse path
    // via parseClassifierOutput's unit tests instead. Here we just verify the
    // classifier wires up without crashing on construction.
    const c = new RealClassifier({ model: fakeModel })
    expect(c).toBeDefined()
  })

  test("honors timeoutMs by racing promises", async () => {
    // Use a model that never resolves to verify timeout
    const neverResolves = {
      specificationVersion: "v2",
      provider: "test",
      modelId: "test",
      doGenerate: () => new Promise(() => {}), // never resolves
      doStream: () => new Promise(() => {}),
      supportedUrls: {},
    } as any
    const c = new RealClassifier({ model: neverResolves })
    const start = Date.now()
    await expect(c.classify({ ...baseInput, timeoutMs: 50 })).rejects.toThrow(/timeout/i)
    const elapsed = Date.now() - start
    // Must have timed out reasonably close to 50ms (not waiting the default 3s)
    expect(elapsed).toBeLessThan(500)
  })

  test("throws on malformed LLM output", async () => {
    const garbageModel = {
      specificationVersion: "v2",
      provider: "test",
      modelId: "test",
      doGenerate: async () => ({
        content: [{ type: "text" as const, text: "this is not JSON" }],
        finishReason: "stop" as const,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        warnings: [],
      }),
      doStream: () => new Promise(() => {}),
      supportedUrls: {},
    } as any
    const c = new RealClassifier({ model: garbageModel })
    await expect(c.classify(baseInput)).rejects.toThrow(/malformed/)
  })

  test("parses valid JSON output", async () => {
    const jsonModel = {
      specificationVersion: "v2",
      provider: "test",
      modelId: "test",
      doGenerate: async () => ({
        content: [{
          type: "text" as const,
          text: '{"decision": "coordinator", "confidence": "high", "reason": "multi-package refactor"}',
        }],
        finishReason: "stop" as const,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        warnings: [],
      }),
      doStream: () => new Promise(() => {}),
      supportedUrls: {},
    } as any
    const c = new RealClassifier({ model: jsonModel })
    const result = await c.classify(baseInput)
    expect(result.decision).toBe("coordinator")
    expect(result.confidence).toBe("high")
    expect(result.reason).toBe("multi-package refactor")
  })

  // Long input prompts (pasted logs, multi-page briefs) must not blow past small-model
  // context limits. RealClassifier truncates to ~2000 chars before embedding.
  test("truncates very long prompts in the user message sent to the model", async () => {
    let sentPrompt: string | undefined
    const captureModel = {
      specificationVersion: "v2",
      provider: "test",
      modelId: "test",
      doGenerate: async (opts: any) => {
        // AI SDK passes messages via opts.prompt — capture the user text for assertion
        const userMsg = opts.prompt?.find?.((m: any) => m.role === "user")
        sentPrompt = userMsg?.content?.[0]?.text ?? JSON.stringify(opts)
        return {
          content: [{ type: "text" as const, text: '{"decision":"single","confidence":"low","reason":"x"}' }],
          finishReason: "stop" as const,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          warnings: [],
        }
      },
      doStream: () => new Promise(() => {}),
      supportedUrls: {},
    } as any
    const c = new RealClassifier({ model: captureModel })
    const huge = "x".repeat(10_000)
    await c.classify({ ...baseInput, prompt: huge })
    expect(sentPrompt).toBeDefined()
    // Must not contain the full 10k of x's
    expect(sentPrompt!.length).toBeLessThan(huge.length)
    // Must contain the truncation marker
    expect(sentPrompt!).toContain("[truncated]")
  })
})
