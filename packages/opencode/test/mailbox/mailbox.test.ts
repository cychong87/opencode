import { describe, test, expect } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { createMailbox, formatAgentID, parseAgentID, isProtocolMessage, type MessageType } from "../../src/mailbox"

describe("mailbox", () => {
  // ── Agent ID Helpers ──

  test("TC-2.10: parseAgentID valid", () => {
    const result = parseAgentID("worker@team")
    expect(result.name).toBe("worker")
    expect(result.team).toBe("team")
  })

  test("TC-2.11: parseAgentID invalid throws", () => {
    expect(() => parseAgentID("bad")).toThrow()
    expect(() => parseAgentID("")).toThrow()
    expect(() => parseAgentID("@team")).toThrow()
    expect(() => parseAgentID("name@")).toThrow()
  })

  test("formatAgentID round-trip", () => {
    const id = formatAgentID("worker", "my-team")
    expect(id).toBe("worker@my-team")
    const parsed = parseAgentID(id)
    expect(parsed.name).toBe("worker")
    expect(parsed.team).toBe("my-team")
  })

  // ── Protocol Message Detection ──

  test("TC-2.8: isProtocolMessage typed", () => {
    expect(isProtocolMessage("idle_notification")).toBe(true)
    expect(isProtocolMessage("shutdown_request")).toBe(true)
    expect(isProtocolMessage("task_assignment")).toBe(true)
    expect(isProtocolMessage("shutdown_approved")).toBe(true)
    expect(isProtocolMessage("shutdown_rejected")).toBe(true)
    expect(isProtocolMessage("plan_approval_request")).toBe(true)
    expect(isProtocolMessage("plan_approval_response")).toBe(true)
  })

  test("TC-2.9: isProtocolMessage plain", () => {
    expect(isProtocolMessage("plain")).toBe(false)
  })

  // ── Mailbox Operations ──

  test("TC-2.1: send and readUnread", async () => {
    await using tmp = await tmpdir()
    const mb = createMailbox(tmp.path)
    const agentID = "worker@test-team"

    await mb.send({
      from: "coord@test-team",
      to: agentID,
      type: "plain",
      content: "Hello worker",
    })

    const messages = await mb.readUnread(agentID)
    expect(messages.length).toBe(1)
    expect(messages[0].from).toBe("coord@test-team")
    expect(messages[0].to).toBe(agentID)
    expect(messages[0].content).toBe("Hello worker")
    expect(messages[0].type).toBe("plain")
    expect(messages[0].read).toBe(false)
    expect(messages[0].id).toMatch(/^msg-/)
    expect(messages[0].timestamp).toBeGreaterThan(0)
  })

  test("TC-2.2: markRead excludes from readUnread", async () => {
    await using tmp = await tmpdir()
    const mb = createMailbox(tmp.path)
    const agentID = "worker@test-team"

    await mb.send({ from: "a@test-team", to: agentID, type: "plain", content: "msg1" })
    await mb.send({ from: "a@test-team", to: agentID, type: "plain", content: "msg2" })

    const before = await mb.readUnread(agentID)
    expect(before.length).toBe(2)

    await mb.markRead(agentID, before[0].id)

    const after = await mb.readUnread(agentID)
    expect(after.length).toBe(1)
    expect(after[0].content).toBe("msg2")
  })

  test("TC-2.3: message ordering is FIFO", async () => {
    await using tmp = await tmpdir()
    const mb = createMailbox(tmp.path)
    const agentID = "worker@test-team"

    await mb.send({ from: "a@test-team", to: agentID, type: "plain", content: "first" })
    await mb.send({ from: "a@test-team", to: agentID, type: "plain", content: "second" })
    await mb.send({ from: "a@test-team", to: agentID, type: "plain", content: "third" })

    const msgs = await mb.readUnread(agentID)
    expect(msgs.length).toBe(3)
    expect(msgs[0].content).toBe("first")
    expect(msgs[1].content).toBe("second")
    expect(msgs[2].content).toBe("third")
  })

  test("TC-2.4: 10 concurrent sends no data loss", async () => {
    await using tmp = await tmpdir()
    const mb = createMailbox(tmp.path)
    const agentID = "target@test-team"

    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        mb.send({
          from: `sender-${i}@test-team`,
          to: agentID,
          type: "plain",
          content: `msg-${i}`,
        }),
      ),
    )

    const messages = await mb.read(agentID)
    expect(messages.length).toBe(10)

    // Verify no duplicates
    const ids = new Set(messages.map((m) => m.id))
    expect(ids.size).toBe(10)
  })

  test("TC-2.5: auto-create inbox directory", async () => {
    await using tmp = await tmpdir()
    const mb = createMailbox(tmp.path)

    // Send to a never-before-seen agent — directory should be created
    await mb.send({
      from: "a@brand-new-team",
      to: "b@brand-new-team",
      type: "plain",
      content: "hello",
    })

    const msgs = await mb.readUnread("b@brand-new-team")
    expect(msgs.length).toBe(1)
  })

  test("TC-2.6: clear empties inbox", async () => {
    await using tmp = await tmpdir()
    const mb = createMailbox(tmp.path)
    const agentID = "worker@test-team"

    await mb.send({ from: "a@test-team", to: agentID, type: "plain", content: "msg" })
    await mb.send({ from: "a@test-team", to: agentID, type: "plain", content: "msg2" })

    await mb.clear(agentID)

    const msgs = await mb.readUnread(agentID)
    expect(msgs.length).toBe(0)
  })

  test("TC-2.7: broadcastToTeam sends to all except sender", async () => {
    await using tmp = await tmpdir()
    const mb = createMailbox(tmp.path)
    const team = "test-team"
    const coordID = formatAgentID("coord", team)

    await mb.broadcastToTeam(coordID, team, ["coord", "alpha", "beta"], {
      type: "plain",
      content: "announcement",
    })

    const alphaMessages = await mb.readUnread(formatAgentID("alpha", team))
    const betaMessages = await mb.readUnread(formatAgentID("beta", team))
    const coordMessages = await mb.readUnread(coordID)

    expect(alphaMessages.length).toBe(1)
    expect(betaMessages.length).toBe(1)
    expect(coordMessages.length).toBe(0) // sender excluded
    expect(alphaMessages[0].content).toBe("announcement")
    expect(alphaMessages[0].from).toBe(coordID)
  })

  test("TC-2.12: all 8 message types can be sent and read", async () => {
    await using tmp = await tmpdir()
    const mb = createMailbox(tmp.path)
    const agentID = "worker@test-team"

    const types: MessageType[] = [
      "plain",
      "task_assignment",
      "idle_notification",
      "shutdown_request",
      "shutdown_approved",
      "shutdown_rejected",
      "plan_approval_request",
      "plan_approval_response",
    ]

    for (const type of types) {
      await mb.send({ from: "a@test-team", to: agentID, type, content: `type: ${type}` })
    }

    const msgs = await mb.read(agentID)
    expect(msgs.length).toBe(8)
    for (let i = 0; i < types.length; i++) {
      expect(msgs[i].type).toBe(types[i])
    }
  })

  test("markAllRead marks everything", async () => {
    await using tmp = await tmpdir()
    const mb = createMailbox(tmp.path)
    const agentID = "worker@test-team"

    await mb.send({ from: "a@test-team", to: agentID, type: "plain", content: "1" })
    await mb.send({ from: "a@test-team", to: agentID, type: "plain", content: "2" })

    await mb.markAllRead(agentID)

    const unread = await mb.readUnread(agentID)
    expect(unread.length).toBe(0)

    const all = await mb.read(agentID)
    expect(all.length).toBe(2)
    expect(all.every((m) => m.read)).toBe(true)
  })

  test("read on non-existent inbox returns empty", async () => {
    await using tmp = await tmpdir()
    const mb = createMailbox(tmp.path)

    const msgs = await mb.read("nobody@no-team")
    expect(msgs.length).toBe(0)
  })

  test("summary and metadata are preserved", async () => {
    await using tmp = await tmpdir()
    const mb = createMailbox(tmp.path)
    const agentID = "worker@test-team"

    await mb.send({
      from: "a@test-team",
      to: agentID,
      type: "idle_notification",
      content: "task done",
      summary: "Worker completed task",
      metadata: { toolCount: 5 },
    })

    const msgs = await mb.readUnread(agentID)
    expect(msgs[0].summary).toBe("Worker completed task")
    expect(msgs[0].metadata).toEqual({ toolCount: 5 })
  })
})
