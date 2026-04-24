import type { HintBlock } from "./types"

const PLACEHOLDER = "{{ROUTER_HINTS}}"

// Package paths and signal names end up inlined into the coordinator system prompt.
// They originate from package.json `name` fields and scorer constants, both of which
// can in principle contain newlines, markdown headers, or prompt-injection-shaped
// content from an untrusted workspace. Scrub control chars and bound length before
// rendering so a hostile package.json can't steer the coordinator.
const MAX_HINT_TOKEN_LENGTH = 120

function sanitizeHintToken(s: string): string {
  return s.replace(/[\r\n\t]+/g, " ").trim().slice(0, MAX_HINT_TOKEN_LENGTH)
}

export function composeCoordinatorPrompt(base: string, hints: HintBlock | null): string {
  if (!base.includes(PLACEHOLDER)) {
    throw new Error("coordinator.txt is missing {{ROUTER_HINTS}} placeholder")
  }
  if (!hints) {
    return base.replaceAll(PLACEHOLDER, "").replace(/\n{3,}/g, "\n\n")
  }
  return base.replaceAll(PLACEHOLDER, renderHintBlock(hints))
}

export function renderHintBlock(hints: HintBlock): string {
  const lines: string[] = [
    "## Router Hints (advisory — override if you disagree)",
    "",
    "The auto-router analyzed this task before you started. Its guesses:",
  ]

  if (hints.suggestedWorkerCount !== undefined) {
    lines.push(`- Suggested worker count: ${hints.suggestedWorkerCount}`)
  }

  if (hints.suggestedPartition && hints.suggestedPartition.length > 0) {
    lines.push("- Suggested partition:")
    for (let i = 0; i < hints.suggestedPartition.length; i++) {
      const sanitized = hints.suggestedPartition[i]
        .map(sanitizeHintToken)
        .filter(s => s.length > 0)
      if (sanitized.length === 0) continue
      lines.push(`  - Worker ${i + 1}: ${sanitized.join(", ")}`)
    }
  }

  if (hints.triggerReasons.length > 0) {
    const safeReasons = hints.triggerReasons.map(sanitizeHintToken).filter(s => s.length > 0)
    if (safeReasons.length > 0) {
      lines.push(`- Signals that triggered coordinator: ${safeReasons.join(", ")}`)
    }
  }

  lines.push(
    "",
    "Use these as a starting point. You are free to spawn fewer or more workers,",
    "or repartition, based on your own judgment.",
  )
  return lines.join("\n")
}
