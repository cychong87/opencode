import type { RoutingDecision } from "./types"

export function formatOverride(agent: string): string {
  return `→ Routing: ${agent} (manual override)`
}

export function formatInherited(decision: RoutingDecision): string {
  return `→ Routing: ${decision.mode} · inherited from previous turn`
}

export function formatRouted(decision: RoutingDecision): string {
  return `→ Routing: ${decision.mode} · ${decision.reason}`
}

export interface AnnounceOptions {
  tuiEmit?: (message: string, variant: "info" | "warning") => void
}

export function emitAnnounce(message: string, opts?: AnnounceOptions): void {
  if (opts?.tuiEmit) {
    opts.tuiEmit(message, "info")
    return
  }
  const isTTY = process.stderr.isTTY
  if (isTTY) {
    process.stderr.write(`\x1b[36m${message}\x1b[0m\n`)
  } else {
    process.stderr.write(message + "\n")
  }
}

export function emitBanner(message: string, opts?: AnnounceOptions): void {
  if (opts?.tuiEmit) {
    opts.tuiEmit(message, "warning")
    return
  }
  process.stderr.write(message + "\n")
}
