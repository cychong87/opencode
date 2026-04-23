import type { RoutingDecision } from "./types"

export class RouterSessionStore {
  private decisions = new Map<string, RoutingDecision>()

  get(sessionId: string): RoutingDecision | null {
    return this.decisions.get(sessionId) ?? null
  }

  set(sessionId: string, decision: RoutingDecision): void {
    this.decisions.set(sessionId, decision)
  }
}
