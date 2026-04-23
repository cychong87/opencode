import fs from "fs/promises"
import path from "path"
import type { TelemetryRecord } from "./types"

export class TelemetryWriter {
  private readonly workspaceRoot: string

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot
  }

  async write(record: TelemetryRecord): Promise<void> {
    const dir = path.join(this.workspaceRoot, ".opencode")
    await fs.mkdir(dir, { recursive: true })
    const today = new Date().toISOString().slice(0, 10)
    const file = path.join(dir, `router-decisions-${today}.jsonl`)
    await fs.appendFile(file, JSON.stringify(record) + "\n")
  }
}

export async function opportunisticCleanup(
  workspaceRoot: string,
  retentionDays: number,
): Promise<void> {
  const dir = path.join(workspaceRoot, ".opencode")
  try {
    const files = await fs.readdir(dir)
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
    for (const file of files) {
      if (!file.startsWith("router-decisions-") && !file.startsWith("router-prompts-")) continue
      const filePath = path.join(dir, file)
      const stat = await fs.stat(filePath)
      if (stat.mtimeMs < cutoff) {
        await fs.unlink(filePath)
      }
    }
  } catch {
    // Directory might not exist — that's fine
  }
}
