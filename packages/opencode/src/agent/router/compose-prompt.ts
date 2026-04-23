import type { HintBlock } from "./types"

const PLACEHOLDER = "{{ROUTER_HINTS}}"

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
      lines.push(`  - Worker ${i + 1}: ${hints.suggestedPartition[i].join(", ")}`)
    }
  }

  if (hints.triggerReasons.length > 0) {
    lines.push(`- Signals that triggered coordinator: ${hints.triggerReasons.join(", ")}`)
  }

  lines.push(
    "",
    "Use these as a starting point. You are free to spawn fewer or more workers,",
    "or repartition, based on your own judgment.",
  )
  return lines.join("\n")
}
