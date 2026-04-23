import path from "path"
import fs from "fs/promises"
import { createHash } from "crypto"
import { Glob } from "bun"

const MANIFEST_PATTERNS = [
  "package.json", "*/package.json",
  "pyproject.toml", "*/pyproject.toml",
  "Cargo.toml", "*/Cargo.toml",
  "go.mod", "*/go.mod",
  "pom.xml", "*/pom.xml",
  "*.sln", "*/*.sln",
]

const EXCLUDED_SEGMENTS = new Set(["node_modules", ".git", "dist", "build"])

export async function computeFingerprint(workspaceRoot: string): Promise<string> {
  const manifests: string[] = []
  for (const pattern of MANIFEST_PATTERNS) {
    const glob = new Glob(pattern)
    for await (const file of glob.scan({ cwd: workspaceRoot, onlyFiles: true })) {
      // Exclude manifests inside node_modules, .git, etc.
      if (!file.split("/").some(seg => EXCLUDED_SEGMENTS.has(seg))) {
        manifests.push(file)
      }
    }
  }
  manifests.sort()

  const entries = await fs.readdir(workspaceRoot, { withFileTypes: true })
  const topDirs = entries
    .filter(e => e.isDirectory() && !e.name.startsWith("."))
    .map(e => e.name)
    .sort()

  const basename = path.basename(workspaceRoot)
  const input = [...manifests, "|", ...topDirs, "|", basename].join("\n")
  return createHash("sha256").update(input).digest("hex").slice(0, 16)
}
