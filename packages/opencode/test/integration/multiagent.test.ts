import { describe, test, expect } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { createMailbox, formatAgentID, parseAgentID } from "../../src/mailbox"
import { createTeamService } from "../../src/team"
import { createTeamTaskService } from "../../src/team-task"
import { toXML, type TaskNotification } from "../../src/notification"

describe("multiagent E2E", () => {
  test("TC-4.8: mailbox round-trip A -> B -> A", async () => {
    await using tmp = await tmpdir()
    const mb = createMailbox(tmp.path)

    const agentA = "alpha@e2e-team"
    const agentB = "beta@e2e-team"

    // A sends to B
    await mb.send({ from: agentA, to: agentB, type: "task_assignment", content: "Do research" })

    // B reads
    const bMsgs = await mb.readUnread(agentB)
    expect(bMsgs.length).toBe(1)
    expect(bMsgs[0].content).toBe("Do research")

    // B replies to A
    await mb.send({ from: agentB, to: agentA, type: "idle_notification", content: "Research done" })

    // A reads
    const aMsgs = await mb.readUnread(agentA)
    expect(aMsgs.length).toBe(1)
    expect(aMsgs[0].content).toBe("Research done")
    expect(aMsgs[0].type).toBe("idle_notification")
  })

  test("TC-4.9: broadcast sends to all except sender", async () => {
    await using tmp = await tmpdir()
    const mb = createMailbox(tmp.path)
    const team = "e2e-team"
    const coordID = formatAgentID("coord", team)

    await mb.broadcastToTeam(coordID, team, ["coord", "alpha", "beta"], {
      type: "plain",
      content: "Team meeting at 3pm",
    })

    expect((await mb.readUnread(formatAgentID("alpha", team))).length).toBe(1)
    expect((await mb.readUnread(formatAgentID("beta", team))).length).toBe(1)
    expect((await mb.readUnread(coordID)).length).toBe(0)
  })

  test("TC-4.10: team lifecycle create -> add -> update -> remove -> delete", async () => {
    await using tmp = await tmpdir()
    const teams = createTeamService(tmp.path)

    // Create
    const team = await teams.create("e2e-team", "E2E test team", "coord@e2e-team", "sess-1")
    expect(team.name).toBe("e2e-team")

    // Add members
    await teams.addMember("e2e-team", {
      agentID: "alpha@e2e-team",
      name: "alpha",
      role: "worker",
      agent: "general",
      sessionID: "sess-2",
      status: "active",
      joinedAt: Date.now(),
    })
    await teams.addMember("e2e-team", {
      agentID: "beta@e2e-team",
      name: "beta",
      role: "worker",
      agent: "explore",
      sessionID: "sess-3",
      status: "active",
      joinedAt: Date.now(),
    })

    let current = await teams.get("e2e-team")
    expect(current.members.length).toBe(2)

    // Update status
    await teams.updateStatus("e2e-team", "alpha@e2e-team", "idle")
    current = await teams.get("e2e-team")
    expect(current.members.find((m) => m.name === "alpha")?.status).toBe("idle")

    // Remove members (must set to non-active first)
    await teams.updateStatus("e2e-team", "alpha@e2e-team", "completed")
    await teams.updateStatus("e2e-team", "beta@e2e-team", "completed")
    await teams.removeMember("e2e-team", "alpha@e2e-team")
    await teams.removeMember("e2e-team", "beta@e2e-team")

    // Delete
    await teams.delete("e2e-team")

    const { existsSync } = await import("fs")
    const dir = await import("path").then((p) => p.join(tmp.path, ".opencode", "teams", "e2e-team"))
    expect(existsSync(dir)).toBe(false)
  })

  test("TC-4.11: shared tasks create -> assign -> blockedBy -> complete -> auto-filter", async () => {
    await using tmp = await tmpdir()
    const tasks = createTeamTaskService(tmp.path)

    // Create 3 tasks
    const taskA = await tasks.create("e2e-team", { subject: "Research auth", description: "Find auth files" })
    const taskB = await tasks.create("e2e-team", { subject: "Implement fix", description: "Fix the bug" })
    const taskC = await tasks.create("e2e-team", { subject: "Write tests", description: "Test the fix" })

    // List shows all 3
    let list = await tasks.list("e2e-team")
    expect(list.length).toBe(3)

    // Assign owners
    await tasks.update("e2e-team", taskA.id, { owner: "alpha", status: "in_progress" })
    await tasks.update("e2e-team", taskB.id, { addBlockedBy: [taskA.id] })
    await tasks.update("e2e-team", taskC.id, { addBlockedBy: [taskB.id] })

    // Verify dependencies
    list = await tasks.list("e2e-team")
    expect(list.find((t) => t.id === taskB.id)?.blockedBy).toContain(taskA.id)
    expect(list.find((t) => t.id === taskC.id)?.blockedBy).toContain(taskB.id)

    // Complete task A
    await tasks.update("e2e-team", taskA.id, { status: "completed" })

    // List should auto-filter completed taskA from taskB's blockedBy
    list = await tasks.list("e2e-team")
    expect(list.find((t) => t.id === taskB.id)?.blockedBy).toEqual([])
    // taskC still blocked by taskB (not completed yet)
    expect(list.find((t) => t.id === taskC.id)?.blockedBy).toContain(taskB.id)
  })

  test("TC-4.12: concurrent mailbox writes", async () => {
    await using tmp = await tmpdir()
    const mb = createMailbox(tmp.path)
    const targetID = "target@e2e-team"

    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        mb.send({ from: `sender-${i}@e2e-team`, to: targetID, type: "plain", content: `msg-${i}` }),
      ),
    )

    const msgs = await mb.read(targetID)
    expect(msgs.length).toBe(10)
    expect(new Set(msgs.map((m) => m.id)).size).toBe(10) // no duplicates
  })

  test("TC-4.2: coordinator prompt contains key sections", async () => {
    const prompt = await Bun.file(
      require("path").join(__dirname, "../../src/agent/prompt/coordinator.txt"),
    ).text()
    expect(prompt).toContain("team_create")
    expect(prompt).toContain("spawn_worker")
    expect(prompt).toContain("terminate_worker")
    expect(prompt).toContain("send_message")
    expect(prompt).toContain("check_mailbox")
    expect(prompt).toContain("Workflow")
    expect(prompt).toContain("Research Phase")
    expect(prompt).toContain("Delegation Phase")
    expect(prompt).toContain("Verification Phase")
  })

  test("agent ID helpers round-trip", () => {
    const id = formatAgentID("worker", "my-team")
    const parsed = parseAgentID(id)
    expect(parsed.name).toBe("worker")
    expect(parsed.team).toBe("my-team")
    expect(formatAgentID(parsed.name, parsed.team)).toBe(id)
  })

  test("XML notification end-to-end", () => {
    const n: TaskNotification = {
      agentID: "researcher@my-team",
      status: "completed",
      summary: "Found & analyzed <3> files",
      result: "auth.ts, login.ts, session.ts",
      toolUses: 12,
      totalTokens: 3500,
      durationMs: 8000,
      worktreePath: "/tmp/wt-abc",
      worktreeBranch: "worktree-agent-abc",
    }
    const xml = toXML(n)
    expect(xml).toContain("<task-notification>")
    expect(xml).toContain("</task-notification>")
    expect(xml).toContain("Found &amp; analyzed &lt;3&gt; files")
    expect(xml).toContain("<path>/tmp/wt-abc</path>")
  })
})
