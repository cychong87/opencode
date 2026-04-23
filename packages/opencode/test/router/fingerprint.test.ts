import { describe, test, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { computeFingerprint } from "@/agent/router/fingerprint"

async function makeTmpDir(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(import.meta.dir, "tmp-fp-"))
  return { path: dir, cleanup: () => fs.rm(dir, { recursive: true }) }
}

describe("computeFingerprint", () => {
  test("identical workspaces produce identical fingerprints", async () => {
    const tmp = await makeTmpDir()
    try {
      await fs.writeFile(path.join(tmp.path, "package.json"), "{}")
      await fs.mkdir(path.join(tmp.path, "src"))
      const fp1 = await computeFingerprint(tmp.path)
      const fp2 = await computeFingerprint(tmp.path)
      expect(fp1).toBe(fp2)
      expect(fp1).toHaveLength(16)
    } finally { await tmp.cleanup() }
  })

  test("adding a .md file does NOT change fingerprint", async () => {
    const tmp = await makeTmpDir()
    try {
      await fs.writeFile(path.join(tmp.path, "package.json"), "{}")
      await fs.mkdir(path.join(tmp.path, "src"))
      const fp1 = await computeFingerprint(tmp.path)
      await fs.writeFile(path.join(tmp.path, "README.md"), "# Hello")
      const fp2 = await computeFingerprint(tmp.path)
      expect(fp1).toBe(fp2)
    } finally { await tmp.cleanup() }
  })

  test("adding a new manifest changes fingerprint", async () => {
    const tmp = await makeTmpDir()
    try {
      await fs.writeFile(path.join(tmp.path, "package.json"), "{}")
      const fp1 = await computeFingerprint(tmp.path)
      await fs.mkdir(path.join(tmp.path, "backend"))
      await fs.writeFile(path.join(tmp.path, "backend", "pyproject.toml"), "")
      const fp2 = await computeFingerprint(tmp.path)
      expect(fp1).not.toBe(fp2)
    } finally { await tmp.cleanup() }
  })

  test("adding a new top-level dir changes fingerprint", async () => {
    const tmp = await makeTmpDir()
    try {
      await fs.writeFile(path.join(tmp.path, "package.json"), "{}")
      const fp1 = await computeFingerprint(tmp.path)
      await fs.mkdir(path.join(tmp.path, "newpkg"))
      const fp2 = await computeFingerprint(tmp.path)
      expect(fp1).not.toBe(fp2)
    } finally { await tmp.cleanup() }
  })
})
