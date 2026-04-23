import { describe, test, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { TelemetryWriter, opportunisticCleanup } from "@/agent/router/telemetry"
import type { TelemetryRecord } from "@/agent/router/types"

async function makeTmpDir() {
  const dir = await fs.mkdtemp(path.join(import.meta.dir, "tmp-tel-"))
  return { path: dir, cleanup: () => fs.rm(dir, { recursive: true }) }
}

describe("TelemetryWriter", () => {
  test("writes JSONL record to daily file", async () => {
    const tmp = await makeTmpDir()
    try {
      const writer = new TelemetryWriter(tmp.path)
      const record = {
        ts: "2026-04-23T12:00:00Z",
        sessionId: "sess1",
        turnIndex: 1,
        source: "routed",
        promptSha: "abc",
        workspaceFingerprint: "def",
        routerDecisionVersion: "v1",
        firedSignalNames: ["P1"],
        taskArchetype: "mutating-broad",
        scores: { prompt: 5, codebase: 4, primary: 4, secondary: 4.6 },
        classifier: { invoked: false, failureMode: null },
        finalDecision: { mode: "single", confidence: "high" },
        fallbackPath: null,
      } as TelemetryRecord
      await writer.write(record)
      const today = new Date().toISOString().slice(0, 10)
      const file = path.join(tmp.path, ".opencode", `router-decisions-${today}.jsonl`)
      const content = await fs.readFile(file, "utf-8")
      expect(content).toContain('"source":"routed"')
      expect(content.trim().split("\n")).toHaveLength(1)
    } finally { await tmp.cleanup() }
  })

  test("appends multiple records to same file", async () => {
    const tmp = await makeTmpDir()
    try {
      const writer = new TelemetryWriter(tmp.path)
      const record = {
        ts: "2026-04-23T12:00:00Z", sessionId: "sess1", turnIndex: 1,
        source: "routed", promptSha: "abc", workspaceFingerprint: "def",
        routerDecisionVersion: "v1", firedSignalNames: [],
        taskArchetype: "trivial",
        scores: { prompt: 1, codebase: 1, primary: 1, secondary: 1 },
        classifier: { invoked: false, failureMode: null },
        finalDecision: { mode: "single", confidence: "high" },
        fallbackPath: null,
      } as TelemetryRecord
      await writer.write(record)
      await writer.write({ ...record, turnIndex: 2 } as TelemetryRecord)
      const today = new Date().toISOString().slice(0, 10)
      const file = path.join(tmp.path, ".opencode", `router-decisions-${today}.jsonl`)
      const lines = (await fs.readFile(file, "utf-8")).trim().split("\n")
      expect(lines).toHaveLength(2)
    } finally { await tmp.cleanup() }
  })
})

describe("opportunisticCleanup", () => {
  test("removes files older than retention period", async () => {
    const tmp = await makeTmpDir()
    try {
      const dir = path.join(tmp.path, ".opencode")
      await fs.mkdir(dir, { recursive: true })
      const oldFile = path.join(dir, "router-decisions-2026-03-01.jsonl")
      const newFile = path.join(dir, "router-decisions-2026-04-22.jsonl")
      await fs.writeFile(oldFile, "{}")
      await fs.writeFile(newFile, "{}")
      const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
      await fs.utimes(oldFile, sixtyDaysAgo, sixtyDaysAgo)
      await opportunisticCleanup(tmp.path, 30)
      const files = await fs.readdir(dir)
      expect(files).not.toContain("router-decisions-2026-03-01.jsonl")
      expect(files).toContain("router-decisions-2026-04-22.jsonl")
    } finally { await tmp.cleanup() }
  })

  test("does not crash on missing directory", async () => {
    await opportunisticCleanup("/nonexistent/path", 30)
    // Should not throw
  })

  test("ignores non-router files", async () => {
    const tmp = await makeTmpDir()
    try {
      const dir = path.join(tmp.path, ".opencode")
      await fs.mkdir(dir, { recursive: true })
      const otherFile = path.join(dir, "some-other-file.json")
      await fs.writeFile(otherFile, "{}")
      const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
      await fs.utimes(otherFile, oldDate, oldDate)
      await opportunisticCleanup(tmp.path, 30)
      const files = await fs.readdir(dir)
      expect(files).toContain("some-other-file.json")
    } finally { await tmp.cleanup() }
  })
})
