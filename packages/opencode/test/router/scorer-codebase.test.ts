import { describe, test, expect } from "bun:test"
import { computeCodebaseSignals } from "@/agent/router/scorer"
import type { WorkspaceAnalysis } from "@/agent/router/types"

function makeAnalysis(overrides: Partial<WorkspaceAnalysis> = {}): WorkspaceAnalysis {
  return {
    totalFiles: 100,
    packageCount: 3,
    packages: ["@app/auth", "@app/api", "@app/shared"],
    languageCount: 1,
    manifestPaths: ["package.json"],
    topLevelDirs: ["packages"],
    ...overrides,
  }
}

describe("computeCodebaseSignals", () => {
  test("C1 bands: <50=0, 50-200=1, 200-1000=2, 1000+=3", () => {
    expect(computeCodebaseSignals(makeAnalysis({ totalFiles: 10 }), []).C1).toBe(0)
    expect(computeCodebaseSignals(makeAnalysis({ totalFiles: 100 }), []).C1).toBe(1)
    expect(computeCodebaseSignals(makeAnalysis({ totalFiles: 500 }), []).C1).toBe(2)
    expect(computeCodebaseSignals(makeAnalysis({ totalFiles: 2000 }), []).C1).toBe(3)
  })

  test("C2 bands: 1=0, 2-3=1, 4-7=2, 8+=3", () => {
    expect(computeCodebaseSignals(makeAnalysis({ packageCount: 1 }), []).C2).toBe(0)
    expect(computeCodebaseSignals(makeAnalysis({ packageCount: 3 }), []).C2).toBe(1)
    expect(computeCodebaseSignals(makeAnalysis({ packageCount: 5 }), []).C2).toBe(2)
    expect(computeCodebaseSignals(makeAnalysis({ packageCount: 10 }), []).C2).toBe(3)
  })

  test("C3 affected subset banding", () => {
    // No mentioned packages → C3 = 0
    expect(computeCodebaseSignals(makeAnalysis(), []).C3).toBe(0)
    // 2 of 3 packages mentioned → rough estimate of affected files
    const result = computeCodebaseSignals(makeAnalysis({ totalFiles: 100, packageCount: 3 }), ["@app/auth", "@app/api"])
    expect(result.C3).toBeGreaterThanOrEqual(1) // ~66 files affected
  })

  test("C4 cross-package: 0 or 2", () => {
    expect(computeCodebaseSignals(makeAnalysis(), ["@app/auth"]).C4).toBe(0)
    expect(computeCodebaseSignals(makeAnalysis(), ["@app/auth", "@app/api"]).C4).toBe(2)
  })

  test("C5 multilanguage: binary", () => {
    expect(computeCodebaseSignals(makeAnalysis({ languageCount: 1 }), []).C5).toBe(0)
    expect(computeCodebaseSignals(makeAnalysis({ languageCount: 2 }), []).C5).toBe(1)
  })

  test("boundary: exactly 50 files = band 1", () => {
    expect(computeCodebaseSignals(makeAnalysis({ totalFiles: 50 }), []).C1).toBe(1)
  })

  test("boundary: exactly 200 files = band 2", () => {
    expect(computeCodebaseSignals(makeAnalysis({ totalFiles: 200 }), []).C1).toBe(2)
  })
})
