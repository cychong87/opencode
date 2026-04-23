import path from "path"
import fs from "fs/promises"
import { Glob } from "bun"
import type { WorkspaceAnalyzer, WorkspaceAnalysis } from "./types"

export class FakeWorkspaceAnalyzer implements WorkspaceAnalyzer {
  private readonly result: WorkspaceAnalysis

  constructor(result: WorkspaceAnalysis) {
    this.result = result
  }

  async analyze(_workspaceRoot: string): Promise<WorkspaceAnalysis> {
    return this.result
  }
}

const MANIFEST_NAMES = ["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml"]
const MANIFEST_LANG_MAP: Record<string, string> = {
  "package.json": "js/ts",
  "pyproject.toml": "python",
  "Cargo.toml": "rust",
  "go.mod": "go",
  "pom.xml": "java",
}

// Directories to exclude from all scans (file count, manifest discovery)
const EXCLUDED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".turbo", ".cache"])

// Single-workspace scoped: cache is per-instance, first call only.
// Create a new instance for each workspace/session.
export class RealWorkspaceAnalyzer implements WorkspaceAnalyzer {
  private cache: WorkspaceAnalysis | null = null

  async analyze(workspaceRoot: string): Promise<WorkspaceAnalysis> {
    if (this.cache) return this.cache

    // Count source files — exclude non-source dirs
    const totalFiles = await countFiles(workspaceRoot)

    // Find manifests at depth 0, 1, and 2 — excluding node_modules etc.
    const manifestSet = new Set<string>()
    for (const name of MANIFEST_NAMES) {
      for (const pattern of [name, `*/${name}`, `*/*/${name}`]) {
        const glob = new Glob(pattern)
        for await (const match of glob.scan({ cwd: workspaceRoot, onlyFiles: true })) {
          // Skip if any path segment is an excluded dir
          if (!isExcludedPath(match)) {
            manifestSet.add(match)
          }
        }
      }
    }
    const manifestPaths = [...manifestSet].sort()

    // Derive packages from depth-1+ manifests (root manifest excluded — no "/" in path)
    const packages = manifestPaths
      .filter(p => p.includes("/"))
      .map(p => path.dirname(p))

    // Count distinct languages from manifest types
    const langs = new Set<string>()
    for (const mp of manifestPaths) {
      const name = path.basename(mp)
      const lang = MANIFEST_LANG_MAP[name]
      if (lang) langs.add(lang)
    }

    // Top-level directories
    const entries = await fs.readdir(workspaceRoot, { withFileTypes: true })
    const topLevelDirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith(".") && !EXCLUDED_DIRS.has(e.name))
      .map(e => e.name)
      .sort()

    const result: WorkspaceAnalysis = {
      totalFiles,
      packageCount: Math.max(1, packages.length),
      packages,
      languageCount: langs.size,
      manifestPaths,
      topLevelDirs,
    }
    this.cache = result
    return result
  }
}

function isExcludedPath(filePath: string): boolean {
  return filePath.split("/").some(segment => EXCLUDED_DIRS.has(segment))
}

async function countFiles(workspaceRoot: string): Promise<number> {
  let count = 0
  const glob = new Glob("**/*")
  for await (const file of glob.scan({ cwd: workspaceRoot, onlyFiles: true })) {
    if (!isExcludedPath(file)) {
      count++
    }
  }
  return count
}
