import { mkdir } from "fs/promises"
import path from "path"
import * as Lock from "../util/lock"

// ── Agent ID Helpers ──

export function formatAgentID(name: string, team: string): string {
  return `${name}@${team}`
}

export function parseAgentID(id: string): { name: string; team: string } {
  const idx = id.indexOf("@")
  if (idx < 1 || idx === id.length - 1) throw new Error(`Invalid agent ID: ${id} (expected name@team)`)
  return { name: id.slice(0, idx), team: id.slice(idx + 1) }
}

// ── Message Types ──

export type MessageType =
  | "plain"
  | "task_assignment"
  | "idle_notification"
  | "shutdown_request"
  | "shutdown_approved"
  | "shutdown_rejected"
  | "plan_approval_request"
  | "plan_approval_response"

export function isProtocolMessage(t: MessageType): boolean {
  return t !== "plain"
}

export interface Message {
  id: string
  from: string
  to: string
  type: MessageType
  content: string
  timestamp: number
  read: boolean
  summary?: string
  metadata?: Record<string, unknown>
}

// ── Service Interface ──

export interface MailboxService {
  send(msg: Omit<Message, "id" | "timestamp" | "read">): Promise<void>
  read(agentID: string): Promise<Message[]>
  readUnread(agentID: string): Promise<Message[]>
  markRead(agentID: string, messageID: string): Promise<void>
  markAllRead(agentID: string): Promise<void>
  clear(agentID: string): Promise<void>
  broadcastToTeam(
    from: string,
    teamName: string,
    members: string[],
    msg: Omit<Message, "id" | "timestamp" | "read" | "from" | "to">,
  ): Promise<void>
}

// ── File-Based Implementation ──

function generateID(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

export function createMailbox(baseDir: string): MailboxService {
  function inboxPath(team: string, name: string) {
    return path.join(baseDir, ".opencode", "teams", team, "inboxes", name + ".json")
  }

  async function ensureDir(filePath: string) {
    await mkdir(path.dirname(filePath), { recursive: true })
  }

  async function loadMessages(filePath: string): Promise<Message[]> {
    const file = Bun.file(filePath)
    if (!(await file.exists())) return []
    const text = await file.text()
    if (!text.trim()) return []
    return JSON.parse(text) as Message[]
  }

  async function saveMessages(filePath: string, messages: Message[]) {
    await Bun.write(filePath, JSON.stringify(messages, null, 2))
  }

  return {
    async send(msg) {
      const { name, team } = parseAgentID(msg.to)
      const fp = inboxPath(team, name)
      await ensureDir(fp)
      using _ = await Lock.write("inbox:" + fp)
      const messages = await loadMessages(fp)
      messages.push({
        ...msg,
        id: generateID(),
        timestamp: Date.now(),
        read: false,
      })
      await saveMessages(fp, messages)
    },

    async read(agentID) {
      const { name, team } = parseAgentID(agentID)
      const fp = inboxPath(team, name)
      using _ = await Lock.read("inbox:" + fp)
      return loadMessages(fp)
    },

    async readUnread(agentID) {
      const { name, team } = parseAgentID(agentID)
      const fp = inboxPath(team, name)
      using _ = await Lock.read("inbox:" + fp)
      const all = await loadMessages(fp)
      return all.filter((m) => !m.read)
    },

    async markRead(agentID, messageID) {
      const { name, team } = parseAgentID(agentID)
      const fp = inboxPath(team, name)
      using _ = await Lock.write("inbox:" + fp)
      const messages = await loadMessages(fp)
      const msg = messages.find((m) => m.id === messageID)
      if (msg) msg.read = true
      await saveMessages(fp, messages)
    },

    async markAllRead(agentID) {
      const { name, team } = parseAgentID(agentID)
      const fp = inboxPath(team, name)
      using _ = await Lock.write("inbox:" + fp)
      const messages = await loadMessages(fp)
      for (const m of messages) m.read = true
      await saveMessages(fp, messages)
    },

    async clear(agentID) {
      const { name, team } = parseAgentID(agentID)
      const fp = inboxPath(team, name)
      await ensureDir(fp)
      using _ = await Lock.write("inbox:" + fp)
      await saveMessages(fp, [])
    },

    async broadcastToTeam(from, teamName, members, msg) {
      const targets = members.filter((m) => formatAgentID(m, teamName) !== from)
      await Promise.all(
        targets.map((member) =>
          this.send({
            ...msg,
            from,
            to: formatAgentID(member, teamName),
          }),
        ),
      )
    },
  }
}

export * as Mailbox from "./index"
