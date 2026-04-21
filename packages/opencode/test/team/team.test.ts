import { describe, test, expect } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { createTeamService } from "../../src/team"
import { formatAgentID } from "../../src/mailbox"
import path from "path"

describe("team", () => {
  test("TC-3.1: create team -> config.json exists", async () => {
    await using tmp = await tmpdir()
    const teams = createTeamService(tmp.path)
    const team = await teams.create("test-team", "Test team", "coordinator@test-team", "sess-1")

    expect(team.name).toBe("test-team")
    expect(team.coordinatorID).toBe("coordinator@test-team")
    expect(team.members).toEqual([])

    const configFile = Bun.file(path.join(tmp.path, ".opencode", "teams", "test-team", "config.json"))
    expect(await configFile.exists()).toBe(true)

    const saved = JSON.parse(await configFile.text())
    expect(saved.name).toBe("test-team")
  })

  test("TC-3.2: addMember -> appears in team", async () => {
    await using tmp = await tmpdir()
    const teams = createTeamService(tmp.path)
    await teams.create("test-team", "", "coord@test-team", "sess-1")

    await teams.addMember("test-team", {
      agentID: "alpha@test-team",
      name: "alpha",
      role: "worker",
      agent: "general",
      sessionID: "sess-2",
      status: "active",
      joinedAt: Date.now(),
    })

    const team = await teams.get("test-team")
    expect(team.members.length).toBe(1)
    expect(team.members[0].name).toBe("alpha")
  })

  test("TC-3.3: removeMember -> gone from team", async () => {
    await using tmp = await tmpdir()
    const teams = createTeamService(tmp.path)
    await teams.create("test-team", "", "coord@test-team", "sess-1")
    await teams.addMember("test-team", {
      agentID: "alpha@test-team",
      name: "alpha",
      role: "worker",
      agent: "general",
      sessionID: "sess-2",
      status: "active",
      joinedAt: Date.now(),
    })

    await teams.removeMember("test-team", "alpha@test-team")

    const team = await teams.get("test-team")
    expect(team.members.length).toBe(0)
  })

  test("TC-3.4: delete with no active members -> directory removed", async () => {
    await using tmp = await tmpdir()
    const teams = createTeamService(tmp.path)
    await teams.create("test-team", "", "coord@test-team", "sess-1")

    await teams.delete("test-team")

    const dir = path.join(tmp.path, ".opencode", "teams", "test-team")
    const { existsSync } = await import("fs")
    expect(existsSync(dir)).toBe(false)
  })

  test("TC-3.5: delete with active member -> error", async () => {
    await using tmp = await tmpdir()
    const teams = createTeamService(tmp.path)
    await teams.create("test-team", "", "coord@test-team", "sess-1")
    await teams.addMember("test-team", {
      agentID: "alpha@test-team",
      name: "alpha",
      role: "worker",
      agent: "general",
      sessionID: "sess-2",
      status: "active",
      joinedAt: Date.now(),
    })

    await expect(teams.delete("test-team")).rejects.toThrow("has active members")
  })

  test("updateStatus changes member status", async () => {
    await using tmp = await tmpdir()
    const teams = createTeamService(tmp.path)
    await teams.create("test-team", "", "coord@test-team", "sess-1")
    await teams.addMember("test-team", {
      agentID: "alpha@test-team",
      name: "alpha",
      role: "worker",
      agent: "general",
      sessionID: "sess-2",
      status: "active",
      joinedAt: Date.now(),
    })

    await teams.updateStatus("test-team", "alpha@test-team", "idle")

    const team = await teams.get("test-team")
    expect(team.members[0].status).toBe("idle")
  })

  test("hasActiveMembers returns correct value", async () => {
    await using tmp = await tmpdir()
    const teams = createTeamService(tmp.path)
    await teams.create("test-team", "", "coord@test-team", "sess-1")

    expect(await teams.hasActiveMembers("test-team")).toBe(false)

    await teams.addMember("test-team", {
      agentID: "alpha@test-team",
      name: "alpha",
      role: "worker",
      agent: "general",
      sessionID: "sess-2",
      status: "active",
      joinedAt: Date.now(),
    })

    expect(await teams.hasActiveMembers("test-team")).toBe(true)

    await teams.updateStatus("test-team", "alpha@test-team", "completed")

    expect(await teams.hasActiveMembers("test-team")).toBe(false)
  })

  test("duplicate addMember throws", async () => {
    await using tmp = await tmpdir()
    const teams = createTeamService(tmp.path)
    await teams.create("test-team", "", "coord@test-team", "sess-1")

    const member = {
      agentID: "alpha@test-team",
      name: "alpha",
      role: "worker" as const,
      agent: "general",
      sessionID: "sess-2",
      status: "active" as const,
      joinedAt: Date.now(),
    }

    await teams.addMember("test-team", member)
    await expect(teams.addMember("test-team", member)).rejects.toThrow("already exists")
  })
})
