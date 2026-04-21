import { describe, test, expect } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { createTeamTaskService } from "../../src/team-task"

describe("team-task", () => {
  test("TC-3.9: create task -> visible in list", async () => {
    await using tmp = await tmpdir()
    const tasks = createTeamTaskService(tmp.path)

    const task = await tasks.create("test-team", {
      subject: "Implement feature",
      description: "Build the new feature module",
    })

    expect(task.id).toMatch(/^task-/)
    expect(task.subject).toBe("Implement feature")
    expect(task.status).toBe("pending")

    const list = await tasks.list("test-team")
    expect(list.length).toBe(1)
    expect(list[0].subject).toBe("Implement feature")
  })

  test("TC-3.10: update status -> reflected in list", async () => {
    await using tmp = await tmpdir()
    const tasks = createTeamTaskService(tmp.path)

    const task = await tasks.create("test-team", {
      subject: "Task A",
      description: "Do A",
    })

    await tasks.update("test-team", task.id, { status: "in_progress" })

    const list = await tasks.list("test-team")
    expect(list[0].status).toBe("in_progress")
  })

  test("TC-3.11: assign owner -> owner field set", async () => {
    await using tmp = await tmpdir()
    const tasks = createTeamTaskService(tmp.path)

    const task = await tasks.create("test-team", {
      subject: "Task A",
      description: "Do A",
    })

    await tasks.update("test-team", task.id, { owner: "alpha" })

    const list = await tasks.list("test-team")
    expect(list[0].owner).toBe("alpha")
  })

  test("TC-3.12: set blockedBy -> blocking IDs listed", async () => {
    await using tmp = await tmpdir()
    const tasks = createTeamTaskService(tmp.path)

    const taskA = await tasks.create("test-team", { subject: "A", description: "Do A" })
    const taskB = await tasks.create("test-team", { subject: "B", description: "Do B" })

    await tasks.update("test-team", taskB.id, { addBlockedBy: [taskA.id] })

    const list = await tasks.list("test-team")
    const b = list.find((t) => t.id === taskB.id)
    expect(b?.blockedBy).toContain(taskA.id)
  })

  test("TC-3.13: complete blocking task -> removed from dependent blockedBy", async () => {
    await using tmp = await tmpdir()
    const tasks = createTeamTaskService(tmp.path)

    const taskA = await tasks.create("test-team", { subject: "A", description: "Do A" })
    const taskB = await tasks.create("test-team", { subject: "B", description: "Do B" })

    await tasks.update("test-team", taskB.id, { addBlockedBy: [taskA.id] })

    // Complete task A
    await tasks.update("test-team", taskA.id, { status: "completed" })

    // List should auto-filter completed task A from B's blockedBy
    const list = await tasks.list("test-team")
    const b = list.find((t) => t.id === taskB.id)
    expect(b?.blockedBy).toEqual([])
  })

  test("deleted tasks hidden from list", async () => {
    await using tmp = await tmpdir()
    const tasks = createTeamTaskService(tmp.path)

    const task = await tasks.create("test-team", { subject: "A", description: "Do A" })
    await tasks.update("test-team", task.id, { status: "deleted" })

    const list = await tasks.list("test-team")
    expect(list.length).toBe(0)
  })

  test("get returns specific task", async () => {
    await using tmp = await tmpdir()
    const tasks = createTeamTaskService(tmp.path)

    const task = await tasks.create("test-team", { subject: "A", description: "Do A" })
    const found = await tasks.get("test-team", task.id)

    expect(found?.id).toBe(task.id)
    expect(found?.subject).toBe("A")
  })

  test("get returns undefined for missing task", async () => {
    await using tmp = await tmpdir()
    const tasks = createTeamTaskService(tmp.path)

    const found = await tasks.get("test-team", "nonexistent")
    expect(found).toBeUndefined()
  })

  test("metadata preserved and merged", async () => {
    await using tmp = await tmpdir()
    const tasks = createTeamTaskService(tmp.path)

    const task = await tasks.create("test-team", {
      subject: "A",
      description: "Do A",
      metadata: { priority: "high" },
    })

    await tasks.update("test-team", task.id, { metadata: { assignee: "bob" } })

    const updated = await tasks.get("test-team", task.id)
    expect(updated?.metadata?.priority).toBe("high")
    expect(updated?.metadata?.assignee).toBe("bob")
  })

  test("update nonexistent task throws", async () => {
    await using tmp = await tmpdir()
    const tasks = createTeamTaskService(tmp.path)

    await expect(tasks.update("test-team", "nonexistent", { status: "completed" })).rejects.toThrow("not found")
  })

  test("list on empty team returns empty", async () => {
    await using tmp = await tmpdir()
    const tasks = createTeamTaskService(tmp.path)

    const list = await tasks.list("test-team")
    expect(list).toEqual([])
  })

  test("multiple tasks created in order", async () => {
    await using tmp = await tmpdir()
    const tasks = createTeamTaskService(tmp.path)

    await tasks.create("test-team", { subject: "First", description: "1" })
    await tasks.create("test-team", { subject: "Second", description: "2" })
    await tasks.create("test-team", { subject: "Third", description: "3" })

    const list = await tasks.list("test-team")
    expect(list.length).toBe(3)
    expect(list[0].subject).toBe("First")
    expect(list[1].subject).toBe("Second")
    expect(list[2].subject).toBe("Third")
  })
})
