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
  // Bands from weights.json: strongSingleMax=0.8, leanSingleMax=1.5, uncertainMax=2.5, leanCoordinatorMax=4.0
  test("[0, 0.8) → single, high", () => {
    const r = applyDecisionBand(0.5, bands)
    expect(r.mode).toBe("single")
    expect(r.confidence).toBe("high")
  })

  test("[0.8, 1.5) → single, medium", () => {
    const r = applyDecisionBand(1.0, bands)
    expect(r.mode).toBe("single")
    expect(r.confidence).toBe("medium")
  })

  test("[1.5, 2.5) → uncertain, medium", () => {
    const r = applyDecisionBand(2.0, bands)
    expect(r.mode).toBe("uncertain")
    expect(r.confidence).toBe("medium")
  })

  test("[2.5, 4.0) → coordinator, medium", () => {
    const r = applyDecisionBand(3.0, bands)
    expect(r.mode).toBe("coordinator")
    expect(r.confidence).toBe("medium")
  })

  test("[4.0, 10] → coordinator, high", () => {
    const r = applyDecisionBand(5.0, bands)
    expect(r.mode).toBe("coordinator")
    expect(r.confidence).toBe("high")
  })

  test("boundary: exactly 0.8 → single, medium", () => {
    const r = applyDecisionBand(0.8, bands)
    expect(r.mode).toBe("single")
    expect(r.confidence).toBe("medium")
  })

  test("boundary: exactly 1.5 → uncertain", () => {
    const r = applyDecisionBand(1.5, bands)
    expect(r.mode).toBe("uncertain")
  })

  test("boundary: exactly 2.5 → coordinator, medium", () => {
    const r = applyDecisionBand(2.5, bands)
    expect(r.mode).toBe("coordinator")
    expect(r.confidence).toBe("medium")
  })

  test("boundary: exactly 4.0 → coordinator, high", () => {
    const r = applyDecisionBand(4.0, bands)
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

  test("boundary: C3 exactly 1 passes through (threshold is < 1)", () => {
    const result = applyFloorRules("mutating-broad", { C3: 1 }, 4)
    expect(result).toBeNull()
  })

  test("boundary: promptScore exactly 6 passes through (threshold is < 6)", () => {
    const result = applyFloorRules("mutating-broad", { C3: 0 }, 6)
    expect(result).toBeNull()
  })
})
