/**
 * Fault injection for the auto-router — ops-debugging hook (Prereq 2 of the
 * v2 test plan). Lets you force specific failure modes to confirm the router
 * falls back cleanly on a live run.
 *
 * Gated behind TWO env vars so production can never activate it accidentally:
 *   OPENCODE_ROUTER_DEBUG=1
 *   OPENCODE_ROUTER_FAULT_INJECT=<mode>
 *
 * Supported modes:
 *   analyzer-fail        — RealWorkspaceAnalyzer.analyze throws
 *   classifier-timeout   — classifier throws a timeout-shaped error (GuardedClassifier
 *                          labels it as "timeout" in fallbackPath / lastFallbackReason)
 *   classifier-malformed — classifier throws a malformed-shaped error (labeled "malformed")
 *
 * Wired at: wire.ts (analyzer), session/prompt.ts (classifier), cli/cmd/debug/router.ts (both).
 */
import type { WorkspaceAnalyzer, LLMClassifier } from "./types"

export type FaultMode = "analyzer-fail" | "classifier-timeout" | "classifier-malformed" | null

const VALID_MODES: ReadonlySet<string> = new Set([
  "analyzer-fail",
  "classifier-timeout",
  "classifier-malformed",
])

export function getFaultMode(env: Record<string, string | undefined> = process.env): FaultMode {
  if (env.OPENCODE_ROUTER_DEBUG !== "1") return null
  const m = env.OPENCODE_ROUTER_FAULT_INJECT
  if (m && VALID_MODES.has(m)) return m as FaultMode
  return null
}

/**
 * Pass the analyzer through untouched unless the fault-inject mode is `analyzer-fail`,
 * in which case return a shim whose `analyze()` always throws. Router's internal
 * try/catch converts that into FALLBACK_DECISION (single/low).
 */
export function withFaultyAnalyzer(real: WorkspaceAnalyzer, mode: FaultMode = getFaultMode()): WorkspaceAnalyzer {
  if (mode !== "analyzer-fail") return real
  return {
    analyze: async () => { throw new Error("fault-inject: analyzer-fail") },
  }
}

/**
 * Pass the classifier through untouched unless the fault-inject mode targets it.
 * Error messages are shaped so GuardedClassifier's substring matcher labels them
 * correctly in `lastFallbackReason` (see classifier.ts:66-72).
 */
export function withFaultyClassifier(
  real: LLMClassifier | undefined,
  mode: FaultMode = getFaultMode(),
): LLMClassifier | undefined {
  if (mode === "classifier-timeout") {
    return { classify: async () => { throw new Error("classifier timeout (fault-inject)") } }
  }
  if (mode === "classifier-malformed") {
    return { classify: async () => { throw new Error("classifier malformed output: fault-inject") } }
  }
  return real
}
