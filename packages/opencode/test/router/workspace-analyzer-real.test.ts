import { describe, test, expect } from "bun:test"
import path from "path"
import { RealWorkspaceAnalyzer, readPyprojectName } from "@/agent/router/workspace-analyzer"

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

  test("polyglot: package name extracted from pyproject.toml", async () => {
    const analyzer = new RealWorkspaceAnalyzer()
    const result = await analyzer.analyze(path.join(FIXTURES, "polyglot"))
    // Name from [project].name in backend/pyproject.toml. Closes the Phase C
    // calibration gap — previously only the directory path was indexed.
    expect(result.packages).toContain("backend")
    // The frontend side (npm) was already indexed; confirm it still is
    expect(result.packages).toContain("frontend")
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

  test("excludes node_modules from file count and package detection", async () => {
    const analyzer = new RealWorkspaceAnalyzer()
    const result = await analyzer.analyze(path.join(FIXTURES, "with-nodemodules"))
    // Should count only src/index.ts + package.json, NOT node_modules/some-pkg/index.js
    expect(result.totalFiles).toBeLessThanOrEqual(2)
    // Should detect only 1 package (root), NOT node_modules/some-pkg
    expect(result.packageCount).toBe(1)
    expect(result.packages).not.toContain("node_modules/some-pkg")
    // node_modules should NOT appear in topLevelDirs
    expect(result.topLevelDirs).not.toContain("node_modules")
  })

  test("monorepo-small exposes BOTH directory paths AND npm names from package.json", async () => {
    const analyzer = new RealWorkspaceAnalyzer()
    const result = await analyzer.analyze(path.join(FIXTURES, "monorepo-small"))
    // Directory paths (for users who refer to packages/auth)
    expect(result.packages).toContain("packages/auth")
    expect(result.packages).toContain("packages/api")
    expect(result.packages).toContain("packages/shared")
    // Scoped npm names from package.json (for users who refer to @app/auth)
    expect(result.packages).toContain("@app/auth")
    expect(result.packages).toContain("@app/api")
    expect(result.packages).toContain("@app/shared")
    // packageCount remains 3 (physical packages), not 6 (the packages list has both aliases)
    expect(result.packageCount).toBe(3)
  })
})

describe("readPyprojectName", () => {
  test("PEP 621 [project].name", () => {
    const toml = `[project]
name = "my-pkg"
version = "0.1.0"
`
    expect(readPyprojectName(toml)).toBe("my-pkg")
  })

  test("Poetry [tool.poetry].name", () => {
    const toml = `[tool.poetry]
name = "poetry-pkg"
version = "0.1.0"
`
    expect(readPyprojectName(toml)).toBe("poetry-pkg")
  })

  test("prefers [project].name over [tool.poetry].name", () => {
    const toml = `[tool.poetry]
name = "old-name"

[project]
name = "new-name"
`
    expect(readPyprojectName(toml)).toBe("new-name")
  })

  test("handles single-quoted name", () => {
    const toml = `[project]
name = 'single-quoted'
`
    expect(readPyprojectName(toml)).toBe("single-quoted")
  })

  test("ignores name fields in unrelated sections", () => {
    const toml = `[tool.mypy]
name = "not-a-project-name"

[build-system]
requires = ["setuptools"]
`
    expect(readPyprojectName(toml)).toBeUndefined()
  })

  test("strips line comments before matching", () => {
    const toml = `[project]
# this is the project name
name = "with-comment"  # inline comment
`
    expect(readPyprojectName(toml)).toBe("with-comment")
  })

  test("returns undefined for empty or nameless TOML", () => {
    expect(readPyprojectName("")).toBeUndefined()
    expect(readPyprojectName("[project]\nversion = \"0.0.0\"\n")).toBeUndefined()
  })

  test("handles subtable headers before the [project] section", () => {
    // Valid TOML ordering — subtable appears before its parent section header.
    // Parser must not get stuck in the subtable and skip the real name.
    const toml = `[project.urls]
homepage = "https://example.com"

[project.optional-dependencies]
dev = ["pytest"]

[project]
name = "my-pkg"
`
    expect(readPyprojectName(toml)).toBe("my-pkg")
  })

  test("subtable after [project] does not clobber the captured name", () => {
    const toml = `[project]
name = "my-pkg"

[project.urls]
homepage = "https://example.com"
`
    expect(readPyprojectName(toml)).toBe("my-pkg")
  })

  test("handles CRLF line endings", () => {
    const toml = "[project]\r\nname = \"crlf-pkg\"\r\n"
    expect(readPyprojectName(toml)).toBe("crlf-pkg")
  })
})
