import { describe, test, expect } from "bun:test"
import { FakeWorkspaceAnalyzer } from "@/agent/router/workspace-analyzer"
import type { WorkspaceAnalysis } from "@/agent/router/types"

describe("FakeWorkspaceAnalyzer", () => {
  const analysis: WorkspaceAnalysis = {
    totalFiles: 100,
    packageCount: 3,
    packages: ["@app/auth", "@app/api", "@app/shared"],
    languageCount: 1,
    manifestPaths: ["package.json", "packages/auth/package.json", "packages/api/package.json"],
    topLevelDirs: ["packages", "scripts", "docs"],
  }

  test("returns configured analysis", async () => {
    const analyzer = new FakeWorkspaceAnalyzer(analysis)
    const result = await analyzer.analyze("/some/path")
    expect(result.totalFiles).toBe(100)
    expect(result.packageCount).toBe(3)
    expect(result.packages).toEqual(["@app/auth", "@app/api", "@app/shared"])
  })

  test("returns same reference on repeated calls (caching behavior)", async () => {
    const analyzer = new FakeWorkspaceAnalyzer(analysis)
    const r1 = await analyzer.analyze("/path1")
    const r2 = await analyzer.analyze("/path2")
    expect(r1).toBe(r2)
  })
})
