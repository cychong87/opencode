import type { RoutingDecision } from "./types"
import { classifyArchetype } from "./scorer"

const INHERITANCE_MAX_AGE_MS = 30 * 60 * 1000
const SHORT_FOLLOW_UP_CHARS = 80
const DEFAULT_MUTATION_VERBS = [
  "refactor", "migrate", "rename", "update", "add", "remove",
  "delete", "replace", "convert", "extract", "move",
]

export interface InheritInput {
  prompt: string
  turnIndex: number
  previousDecision?: RoutingDecision
  currentFingerprint: string
}

export type InheritResult =
  | { inherit: true }
  | { inherit: false; escape: string }

export function shouldInherit(input: InheritInput): InheritResult {
  if (!input.previousDecision) return { inherit: false, escape: "no_prior" }
  if (input.turnIndex < 2) return { inherit: false, escape: "first_turn" }

  const prior = input.previousDecision

  // Priority 1: explicit /reroute
  if (input.prompt.trim().startsWith("/reroute")) {
    return { inherit: false, escape: "reroute" }
  }

  // Priority 2: fingerprint drift
  if (prior.workspaceFingerprint !== input.currentFingerprint) {
    return { inherit: false, escape: "drift" }
  }

  // Priority 3: staleness
  if (Date.now() - prior.decidedAt > INHERITANCE_MAX_AGE_MS) {
    return { inherit: false, escape: "stale" }
  }

  // Priority 4: short follow-up (trivial/conversational only — read-only queries and mutating
  // prompts are substantive even when short)
  const hasPathRef = /[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+/.test(input.prompt)
  if (
    input.prompt.length < SHORT_FOLLOW_UP_CHARS &&
    !hasPathRef &&
    classifyArchetype(input.prompt, DEFAULT_MUTATION_VERBS) === "trivial"
  ) {
    return { inherit: false, escape: "short_follow" }
  }

  // Priority 5: archetype flip to read-only
  if (prior.mode === "coordinator") {
    const archetype = classifyArchetype(input.prompt, DEFAULT_MUTATION_VERBS)
    if (archetype === "read-only") {
      return { inherit: false, escape: "archetype" }
    }
  }

  return { inherit: true }
}
