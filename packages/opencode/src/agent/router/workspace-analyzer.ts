import path from "path"
import fs from "fs/promises"
import { Glob } from "@opencode-ai/shared/util/glob"
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
        const matches = await Glob.scan(pattern, { cwd: workspaceRoot, include: "file" })
        for (const match of matches) {
          if (!isExcludedPath(match)) {
            manifestSet.add(match)
          }
        }
      }
    }
    const manifestPaths = [...manifestSet].sort()

    // Derive package identifiers from depth-1+ manifests. Users mention their packages
    // both by scoped npm name (@org/auth) AND by directory path (packages/auth) — so we
    // include BOTH when available. Signal matching deduplicates, so this just improves recall.
    const packages: string[] = []
    const seenPackageNames = new Set<string>()
    for (const mp of manifestPaths) {
      if (!mp.includes("/")) continue // skip root manifest
      const dirPath = path.dirname(mp)
      if (!seenPackageNames.has(dirPath)) {
        seenPackageNames.add(dirPath)
        packages.push(dirPath)
      }
      // Try to extract the declared package name from the manifest.
      // Covers npm package.json (`name` field) and Python pyproject.toml
      // (`[project].name` per PEP 621, or `[tool.poetry].name` for Poetry projects).
      // Other manifest types fall through and are only identified by directory path.
      if (mp.endsWith("package.json") || mp.endsWith("pyproject.toml")) {
        const pkgName = await readManifestName(path.join(workspaceRoot, mp))
        if (pkgName && !seenPackageNames.has(pkgName)) {
          seenPackageNames.add(pkgName)
          packages.push(pkgName)
        }
      }
    }

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

    // packageCount counts distinct depth-1+ manifests (one per physical package).
    // Use the manifestSet depth, not packages.length — packages[] may contain both
    // directory paths and npm names for the same package.
    const physicalPackageCount = manifestPaths.filter(p => p.includes("/")).length

    const result: WorkspaceAnalysis = {
      totalFiles,
      packageCount: Math.max(1, physicalPackageCount),
      packages,
      languageCount: langs.size,
      manifestPaths,
      topLevelDirs,
    }
    this.cache = result
    return result
  }
}

async function readManifestName(manifestPath: string): Promise<string | undefined> {
  try {
    const content = await fs.readFile(manifestPath, "utf-8")
    if (manifestPath.endsWith("pyproject.toml")) {
      return readPyprojectName(content)
    }
    const parsed = JSON.parse(content) as { name?: unknown }
    if (typeof parsed.name === "string" && parsed.name.length > 0) {
      return parsed.name
    }
  } catch {
    // Malformed content, missing file, etc. — non-fatal
  }
  return undefined
}

// Minimal pyproject.toml name extractor. Line-oriented scanner covers the
// PEP 621 `[project].name` and Poetry's `[tool.poetry].name` — the only two
// forms that show up in practice. Prefers [project] when both are present.
// Not a full TOML parser: multi-line strings and escapes in `name` would not
// be handled, but those are vanishingly rare for project names. Subtable
// headers (`[project.urls]`, `[project.optional-dependencies]`) land in
// non-target sections and are correctly ignored regardless of where they
// appear relative to the `[project]` section header.
export function readPyprojectName(content: string): string | undefined {
  const targets = new Set(["project", "tool.poetry"])
  let currentSection = ""
  let poetryName: string | undefined
  for (const raw of content.split("\n")) {
    const line = raw.replace(/\s*#.*$/, "").trim()
    const header = line.match(/^\[([^\]]+)\]$/)
    if (header) { currentSection = header[1]; continue }
    if (!targets.has(currentSection)) continue
    const m = line.match(/^name\s*=\s*(?:"([^"]+)"|'([^']+)')\s*$/)
    if (!m) continue
    const name = m[1] ?? m[2]
    if (currentSection === "project") return name
    poetryName = poetryName ?? name
  }
  return poetryName
}

function isExcludedPath(filePath: string): boolean {
  return filePath.split("/").some(segment => EXCLUDED_DIRS.has(segment))
}

async function countFiles(workspaceRoot: string): Promise<number> {
  const files = await Glob.scan("**/*", { cwd: workspaceRoot, include: "file" })
  let count = 0
  for (const file of files) {
    if (!isExcludedPath(file)) count++
  }
  return count
}
