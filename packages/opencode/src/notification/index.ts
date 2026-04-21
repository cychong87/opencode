export interface TaskNotification {
  agentID: string
  status: "completed" | "failed" | "killed"
  summary: string
  result?: string
  toolUses: number
  totalTokens: number
  durationMs: number
  worktreePath?: string
  worktreeBranch?: string
}

function escapeXML(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

export function toXML(n: TaskNotification): string {
  const lines: string[] = ["<task-notification>"]
  lines.push(`  <agent-id>${escapeXML(n.agentID)}</agent-id>`)
  lines.push(`  <status>${n.status}</status>`)
  lines.push(`  <summary>${escapeXML(n.summary)}</summary>`)
  if (n.result) lines.push(`  <result>${escapeXML(n.result)}</result>`)
  lines.push(`  <usage>`)
  lines.push(`    <total_tokens>${n.totalTokens}</total_tokens>`)
  lines.push(`    <tool_uses>${n.toolUses}</tool_uses>`)
  lines.push(`    <duration_ms>${n.durationMs}</duration_ms>`)
  lines.push(`  </usage>`)
  if (n.worktreePath) {
    lines.push(`  <worktree>`)
    lines.push(`    <path>${escapeXML(n.worktreePath)}</path>`)
    lines.push(`    <branch>${escapeXML(n.worktreeBranch ?? "")}</branch>`)
    lines.push(`  </worktree>`)
  }
  lines.push("</task-notification>")
  return lines.join("\n")
}

export * as Notification from "./index"
