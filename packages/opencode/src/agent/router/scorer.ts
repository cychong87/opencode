import type { TaskArchetype, WorkspaceAnalysis, RouterConfig } from "./types"

const COMMON_ENGLISH_WORDS = new Set([
  "core", "utils", "api", "app", "shared", "common", "base",
  "data", "config", "server", "client", "web", "test", "lib",
])

export function extractP1GlobMentions(prompt: string): number {
  const globPattern = /\S*(?:\*\*|\*\.|\.\*|\?|[\[{][^\s\]]*[\]}])\S*/g
  const matches = prompt.match(globPattern)
  const unique = new Set(matches ?? [])
  return Math.min(unique.size, 3)
}

export function extractP2PackageMentions(prompt: string, packageNames: string[]): number {
  let count = 0
  const seen = new Set<string>()

  for (const pkg of packageNames) {
    if (seen.has(pkg)) continue

    const isScoped = pkg.startsWith("@")
    const isCommonWord = COMMON_ENGLISH_WORDS.has(pkg.toLowerCase())

    let matched = false

    if (isScoped) {
      matched = prompt.includes(pkg)
    } else if (isCommonWord) {
      const backticked = new RegExp("`" + escapeRegex(pkg) + "`")
      const quoted = new RegExp(`["']${escapeRegex(pkg)}["']`)
      matched = backticked.test(prompt) || quoted.test(prompt)
    } else {
      const boundary = new RegExp(`\\b${escapeRegex(pkg)}\\b`)
      matched = boundary.test(prompt)
    }

    if (matched) {
      seen.add(pkg)
      count++
    }
  }
  return Math.min(count, 4)
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function extractP3ScopeKeywords(
  prompt: string,
  scopeKeywords: string[],
  mutationVerbs: string[],
): number {
  const lower = prompt.toLowerCase()
  const hasMutationVerb = mutationVerbs.some(v => lower.includes(v))
  if (!hasMutationVerb) return 0

  let count = 0
  for (const kw of scopeKeywords) {
    if (lower.includes(kw.toLowerCase())) count++
  }
  return Math.min(count, 3)
}

export function extractP4ConjunctionChains(prompt: string, mutationVerbs: string[]): number {
  const lower = prompt.toLowerCase()
  const clauses = lower.split(/\s+(?:and|then|also)\s+/)

  let mutationClauseCount = 0
  for (const clause of clauses) {
    if (mutationVerbs.some(v => clause.includes(v))) {
      mutationClauseCount++
    }
  }
  return Math.min(Math.max(0, mutationClauseCount - 1), 3)
}

const READ_ONLY_VERBS = ["explain", "describe", "show", "list", "find", "search", "what", "how", "why", "where"]
const TRIVIAL_PATTERNS = [/\bfix\b.*\btypo\b/i, /\bfix\b.*\bline\s+\d+/i, /\bone\s+line\b/i]
const BROAD_INDICATORS = ["all", "every", "across", "entire", "whole", "throughout"]

export function extractP5ExplicitPaths(prompt: string, projectDirs: string[]): number {
  const tokens = prompt.split(/\s+/)
  let count = 0

  for (const token of tokens) {
    if (!token.includes("/")) continue
    if (/^https?:\/\//i.test(token)) continue
    if (/^and\/or$/i.test(token)) continue
    if (/^n\/a$/i.test(token)) continue

    const hasExtension = /\.\w{1,5}$/.test(token)
    const hasProjectPrefix = projectDirs.some(d => token.startsWith(d + "/"))

    if (hasExtension || hasProjectPrefix) {
      count++
    }
  }
  return Math.min(count, 4)
}

export function classifyArchetype(prompt: string, mutationVerbs: string[]): TaskArchetype {
  const lower = prompt.toLowerCase()
  const words = lower.split(/\s+/)
  const firstWord = words[0]

  // Check read-only — only if NO mutation verb is present
  const hasMutation = mutationVerbs.some(v => lower.includes(v))
  if (READ_ONLY_VERBS.some(v => firstWord === v) && !hasMutation) {
    return "read-only"
  }
  if (lower.includes("?") && !hasMutation) {
    return "read-only"
  }

  // Check trivial
  if (TRIVIAL_PATTERNS.some(p => p.test(lower))) {
    return "trivial"
  }

  // Check mutating
  if (!hasMutation) {
    return "trivial"
  }

  // Broad vs narrow
  const hasBroadIndicator = BROAD_INDICATORS.some(kw => lower.includes(kw))
  return hasBroadIndicator ? "mutating-broad" : "mutating-narrow"
}

export interface CodebaseSignals {
  C1: number
  C2: number
  C3: number
  C4: number
  C5: number
}

function band(value: number, thresholds: [number, number, number]): number {
  if (value >= thresholds[2]) return 3
  if (value >= thresholds[1]) return 2
  if (value >= thresholds[0]) return 1
  return 0
}

export function computeCodebaseSignals(
  analysis: WorkspaceAnalysis,
  mentionedPackages: string[],
): CodebaseSignals {
  const C1 = band(analysis.totalFiles, [50, 200, 1000])
  const C2 = band(analysis.packageCount, [2, 4, 8])

  // Proportional estimate — assumes uniform file distribution across packages.
  // TODO: use per-package file counts when WorkspaceAnalysis carries them (v2).
  const affectedSubset = mentionedPackages.length > 0
    ? Math.floor(analysis.totalFiles * (mentionedPackages.length / Math.max(1, analysis.packageCount)))
    : 0
  const C3 = band(affectedSubset, [5, 16, 40])

  const uniqueMentioned = new Set(mentionedPackages)
  const C4 = uniqueMentioned.size >= 2 ? 2 : 0

  const C5 = analysis.languageCount > 1 ? 1 : 0

  return { C1, C2, C3, C4, C5 }
}

export interface CompositeScore {
  primary: number
  secondary: number
}

export function computeComposite(promptScore: number, codebaseScore: number): CompositeScore {
  return {
    primary: Math.min(promptScore, codebaseScore),
    secondary: 0.6 * promptScore + 0.4 * codebaseScore,
  }
}

export interface BandResult {
  mode: "single" | "coordinator" | "uncertain"
  confidence: "high" | "medium" | "low"
}

export function applyDecisionBand(
  primaryScore: number,
  bands: RouterConfig["bands"],
): BandResult {
  if (primaryScore < bands.strongSingleMax) return { mode: "single", confidence: "high" }
  if (primaryScore < bands.leanSingleMax) return { mode: "single", confidence: "medium" }
  if (primaryScore < bands.uncertainMax) return { mode: "uncertain", confidence: "medium" }
  if (primaryScore < bands.leanCoordinatorMax) return { mode: "coordinator", confidence: "medium" }
  return { mode: "coordinator", confidence: "high" }
}

export function applyFloorRules(
  archetype: TaskArchetype,
  codebaseSignals: Pick<CodebaseSignals, "C3">,
  promptScore: number,
): "single" | null {
  if (archetype === "read-only") return "single"
  if (codebaseSignals.C3 < 1 && promptScore < 6) return "single"
  return null
}
