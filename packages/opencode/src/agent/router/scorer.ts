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
