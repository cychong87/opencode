import { describe, test, expect } from "bun:test"
import path from "path"
import { RealWorkspaceAnalyzer } from "@/agent/router/workspace-analyzer"

const FIXTURES = path.resolve(import.meta.dir, "../../src/agent/router/fixtures/workspaces")

describe("RealWorkspaceAnalyzer", () => {
  test("single-pkg: 1 package, js/ts language", async () => {
    const analyzer = new RealWorkspaceAnalyzer()
    const result = await analyzer.analyze(path.join(FIXTURES, "single-pkg"))
    expect(result.packageCount).toBe(1)
    expect(result.languageCount).toBe(1)
    expect(result.totalFiles).toBeGreaterThanOrEqual(5)
  })

  test("monorepo-small: 3 sub-packages detected", async () => {
    const analyzer = new RealWorkspaceAnalyzer()
    const result = await analyzer.analyze(path.join(FIXTURES, "monorepo-small"))
    expect(result.packageCount).toBe(3)
    expect(result.packages).toContain("packages/auth")
    expect(result.packages).toContain("packages/api")
    expect(result.packages).toContain("packages/shared")
  })

  test("polyglot: 2 languages detected", async () => {
    const analyzer = new RealWorkspaceAnalyzer()
    const result = await analyzer.analyze(path.join(FIXTURES, "polyglot"))
    expect(result.languageCount).toBe(2)
  })

  test("caches result on second call (same reference)", async () => {
    const analyzer = new RealWorkspaceAnalyzer()
    const r1 = await analyzer.analyze(path.join(FIXTURES, "single-pkg"))
    const r2 = await analyzer.analyze(path.join(FIXTURES, "single-pkg"))
    expect(r1).toBe(r2) // same object reference
  })

  test("empty workspace: returns valid analysis", async () => {
    const analyzer = new RealWorkspaceAnalyzer()
    const result = await analyzer.analyze(path.join(FIXTURES, "empty"))
    expect(result.totalFiles).toBe(0)
    expect(result.packageCount).toBe(1) // min 1
    expect(result.languageCount).toBe(0)
  })
})
