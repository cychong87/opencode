import { mkdir } from "fs/promises"
import path from "path"
import * as Lock from "../util/lock"

export interface Team {
  name: string
  description?: string
  createdAt: number
  coordinatorID: string
  leadSessionID: string
  members: TeamMember[]
}

export interface TeamMember {
  agentID: string
  name: string
  role: "coordinator" | "worker"
  agent: string
  sessionID: string
  status: "active" | "idle" | "completed" | "failed" | "killed"
  joinedAt: number
}

export interface TeamService {
  create(name: string, description: string, coordinatorID: string, leadSessionID: string): Promise<Team>
  get(name: string): Promise<Team>
  addMember(teamName: string, member: TeamMember): Promise<void>
  removeMember(teamName: string, agentID: string): Promise<void>
  updateStatus(teamName: string, agentID: string, status: TeamMember["status"]): Promise<void>
  hasActiveMembers(teamName: string): Promise<boolean>
  delete(teamName: string): Promise<void>
}

export function createTeamService(baseDir: string): TeamService {
  function teamDir(name: string) {
    return path.join(baseDir, ".opencode", "teams", name)
  }

  function configPath(name: string) {
    return path.join(teamDir(name), "config.json")
  }

  function lockKey(name: string) {
    return "team:" + configPath(name)
  }

  async function loadTeam(name: string): Promise<Team> {
    const file = Bun.file(configPath(name))
    if (!(await file.exists())) throw new Error(`Team not found: ${name}`)
    return JSON.parse(await file.text()) as Team
  }

  async function saveTeam(name: string, team: Team) {
    await Bun.write(configPath(name), JSON.stringify(team, null, 2))
  }

  return {
    async create(name, description, coordinatorID, leadSessionID) {
      const dir = teamDir(name)
      await mkdir(dir, { recursive: true })
      await mkdir(path.join(dir, "inboxes"), { recursive: true })

      const team: Team = {
        name,
        description,
        createdAt: Date.now(),
        coordinatorID,
        leadSessionID,
        members: [],
      }

      using _ = await Lock.write(lockKey(name))
      await saveTeam(name, team)
      return team
    },

    async get(name) {
      using _ = await Lock.read(lockKey(name))
      return loadTeam(name)
    },

    async addMember(teamName, member) {
      using _ = await Lock.write(lockKey(teamName))
      const team = await loadTeam(teamName)
      const existing = team.members.find((m) => m.agentID === member.agentID)
      if (existing) throw new Error(`Member ${member.agentID} already exists in team ${teamName}`)
      team.members.push(member)
      await saveTeam(teamName, team)
    },

    async removeMember(teamName, agentID) {
      using _ = await Lock.write(lockKey(teamName))
      const team = await loadTeam(teamName)
      team.members = team.members.filter((m) => m.agentID !== agentID)
      await saveTeam(teamName, team)
    },

    async updateStatus(teamName, agentID, status) {
      using _ = await Lock.write(lockKey(teamName))
      const team = await loadTeam(teamName)
      const member = team.members.find((m) => m.agentID === agentID)
      if (member) member.status = status
      await saveTeam(teamName, team)
    },

    async hasActiveMembers(teamName) {
      using _ = await Lock.read(lockKey(teamName))
      const team = await loadTeam(teamName)
      return team.members.some((m) => m.status === "active" || m.status === "idle")
    },

    async delete(teamName) {
      const hasActive = await this.hasActiveMembers(teamName)
      if (hasActive) throw new Error(`Cannot delete team ${teamName}: has active members. Terminate all workers first.`)
      const { rm } = await import("fs/promises")
      await rm(teamDir(teamName), { recursive: true, force: true })
    },
  }
}

export * as Team from "./index"
