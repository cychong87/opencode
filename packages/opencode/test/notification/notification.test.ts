import { describe, test, expect } from "bun:test"
import { toXML, type TaskNotification } from "../../src/notification"

describe("notification", () => {
  test("TC-4.3: basic notification XML", () => {
    const n: TaskNotification = {
      agentID: "researcher@team",
      status: "completed",
      summary: "Found 3 files",
      result: "File A, File B, File C",
      toolUses: 15,
      totalTokens: 4500,
      durationMs: 12000,
    }
    const xml = toXML(n)
    expect(xml).toContain("<task-notification>")
    expect(xml).toContain("</task-notification>")
    expect(xml).toContain("<agent-id>researcher@team</agent-id>")
    expect(xml).toContain("<status>completed</status>")
    expect(xml).toContain("<summary>Found 3 files</summary>")
    expect(xml).toContain("<result>File A, File B, File C</result>")
    expect(xml).toContain("<total_tokens>4500</total_tokens>")
    expect(xml).toContain("<tool_uses>15</tool_uses>")
    expect(xml).toContain("<duration_ms>12000</duration_ms>")
    expect(xml).not.toContain("<worktree>")
  })

  test("TC-4.4: escapes XML special characters", () => {
    const n: TaskNotification = {
      agentID: "test@team",
      status: "completed",
      summary: 'Found <script> & "issues"',
      toolUses: 1,
      totalTokens: 100,
      durationMs: 1000,
    }
    const xml = toXML(n)
    expect(xml).toContain("&lt;script&gt;")
    expect(xml).toContain("&amp;")
    expect(xml).toContain("&quot;issues&quot;")
    expect(xml).not.toContain("<script>")
  })

  test("TC-4.5: includes worktree when present", () => {
    const n: TaskNotification = {
      agentID: "impl@team",
      status: "completed",
      summary: "Done",
      toolUses: 5,
      totalTokens: 2000,
      durationMs: 5000,
      worktreePath: "/tmp/worktree",
      worktreeBranch: "worktree-agent-abc",
    }
    const xml = toXML(n)
    expect(xml).toContain("<worktree>")
    expect(xml).toContain("<path>/tmp/worktree</path>")
    expect(xml).toContain("<branch>worktree-agent-abc</branch>")
    expect(xml).toContain("</worktree>")
  })

  test("TC-4.6: omits worktree when not present", () => {
    const n: TaskNotification = {
      agentID: "test@team",
      status: "failed",
      summary: "Error occurred",
      toolUses: 0,
      totalTokens: 50,
      durationMs: 500,
    }
    const xml = toXML(n)
    expect(xml).not.toContain("<worktree>")
    expect(xml).not.toContain("<path>")
    expect(xml).not.toContain("<branch>")
  })

  test("omits result when not provided", () => {
    const n: TaskNotification = {
      agentID: "test@team",
      status: "killed",
      summary: "Cancelled",
      toolUses: 3,
      totalTokens: 200,
      durationMs: 2000,
    }
    const xml = toXML(n)
    expect(xml).not.toContain("<result>")
    expect(xml).toContain("<status>killed</status>")
  })
})
