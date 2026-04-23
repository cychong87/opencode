import { describe, test, expect } from "bun:test"
import { computeComposite, applyDecisionBand, applyFloorRules } from "@/agent/router/scorer"
import type { RouterConfig } from "@/agent/router/types"
import defaultWeights from "@/agent/router/weights.json"

const bands = (defaultWeights as unknown as RouterConfig).bands

describe("computeComposite", () => {
  test("primaryScore = min(prompt, codebase)", () => {
    const result = computeComposite(7, 4)
    expect(result.primary).toBe(4)
  })

  test("primaryScore when prompt is lower", () => {
    const result = computeComposite(3, 8)
    expect(result.primary).toBe(3)
  })

  test("secondaryScore = 0.6*prompt + 0.4*codebase", () => {
    const result = computeComposite(7, 4)
    expect(result.secondary).toBeCloseTo(5.8, 1)
  })

  test("equal scores", () => {
    const result = computeComposite(5, 5)
    expect(result.primary).toBe(5)
    expect(result.secondary).toBe(5)
  })
})

describe("applyDecisionBand", () => {
  test("[0, 3) → single, high", () => {
    const r = applyDecisionBand(2, bands)
    expect(r.mode).toBe("single")
    expect(r.confidence).toBe("high")
  })

  test("[3, 4.5) → single, medium", () => {
    const r = applyDecisionBand(3.5, bands)
    expect(r.mode).toBe("single")
    expect(r.confidence).toBe("medium")
  })

  test("[4.5, 6) → uncertain, medium", () => {
    const r = applyDecisionBand(5, bands)
    expect(r.mode).toBe("uncertain")
    expect(r.confidence).toBe("medium")
  })

  test("[6, 7.5) → coordinator, medium", () => {
    const r = applyDecisionBand(6.5, bands)
    expect(r.mode).toBe("coordinator")
    expect(r.confidence).toBe("medium")
  })

  test("[7.5, 10] → coordinator, high", () => {
    const r = applyDecisionBand(8, bands)
    expect(r.mode).toBe("coordinator")
    expect(r.confidence).toBe("high")
  })

  test("boundary: exactly 3 → single, medium", () => {
    const r = applyDecisionBand(3, bands)
    expect(r.mode).toBe("single")
    expect(r.confidence).toBe("medium")
  })

  test("boundary: exactly 4.5 → uncertain", () => {
    const r = applyDecisionBand(4.5, bands)
    expect(r.mode).toBe("uncertain")
  })

  test("boundary: exactly 6 → coordinator, medium", () => {
    const r = applyDecisionBand(6, bands)
    expect(r.mode).toBe("coordinator")
    expect(r.confidence).toBe("medium")
  })

  test("boundary: exactly 7.5 → coordinator, high", () => {
    const r = applyDecisionBand(7.5, bands)
    expect(r.mode).toBe("coordinator")
    expect(r.confidence).toBe("high")
  })

  test("zero → single, high", () => {
    const r = applyDecisionBand(0, bands)
    expect(r.mode).toBe("single")
    expect(r.confidence).toBe("high")
  })
})

describe("applyFloorRules", () => {
  test("read-only archetype forces single", () => {
    const result = applyFloorRules("read-only", { C3: 3 }, 8)
    expect(result).toBe("single")
  })

  test("small C3 + low prompt score forces single", () => {
    const result = applyFloorRules("mutating-broad", { C3: 0 }, 4)
    expect(result).toBe("single")
  })

  test("large C3 + high prompt score passes through", () => {
    const result = applyFloorRules("mutating-broad", { C3: 2 }, 7)
    expect(result).toBeNull()
  })

  test("small C3 but high prompt score passes through", () => {
    const result = applyFloorRules("mutating-broad", { C3: 0 }, 7)
    expect(result).toBeNull()
  })

  test("trivial archetype does NOT force single on its own", () => {
    const result = applyFloorRules("trivial", { C3: 2 }, 7)
    expect(result).toBeNull()
  })
})
