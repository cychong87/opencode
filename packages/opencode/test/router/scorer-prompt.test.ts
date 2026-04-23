import { describe, test, expect } from "bun:test"
import { extractP1GlobMentions, extractP2PackageMentions } from "@/agent/router/scorer"
import { extractP3ScopeKeywords, extractP4ConjunctionChains } from "@/agent/router/scorer"
import { extractP5ExplicitPaths, classifyArchetype } from "@/agent/router/scorer"
import type { TaskArchetype } from "@/agent/router/types"

describe("P1_glob_mentions", () => {
  test("detects ** glob pattern", () => {
    expect(extractP1GlobMentions("update **/*.ts files")).toBe(1)
  })

  test("detects multiple globs, capped at 3", () => {
    expect(extractP1GlobMentions("fix **/*.ts and src/**/*.js and lib/*.py and test/**")).toBe(3)
  })

  test("returns 0 for no globs", () => {
    expect(extractP1GlobMentions("fix the login bug")).toBe(0)
  })
})

describe("P2_package_mentions", () => {
  const packages = ["@app/auth", "@app/api", "shared-utils", "core"]

  test("detects scoped package names", () => {
    expect(extractP2PackageMentions("update @app/auth and @app/api", packages)).toBe(2)
  })

  test("detects backticked names", () => {
    expect(extractP2PackageMentions("fix `core` module", packages)).toBe(1)
  })

  test("rejects bare common English words without markup", () => {
    expect(extractP2PackageMentions("the core issue is the api", packages)).toBe(0)
  })

  test("matches non-English-word package names without markup", () => {
    expect(extractP2PackageMentions("fix shared-utils", packages)).toBe(1)
  })

  test("caps at 4", () => {
    const manyPkgs = ["@a/b", "@a/c", "@a/d", "@a/e", "@a/f"]
    expect(extractP2PackageMentions("@a/b @a/c @a/d @a/e @a/f", manyPkgs)).toBe(4)
  })
})

const MUTATION_VERBS = [
  "refactor", "migrate", "rename", "update", "add", "remove",
  "delete", "replace", "convert", "extract", "move",
]
const SCOPE_KEYWORDS = ["all", "every", "across", "entire", "whole", "throughout", "codebase-wide", "repo-wide"]

describe("P3_scope_keywords", () => {
  test("fires when scope keyword co-occurs with mutation verb", () => {
    expect(extractP3ScopeKeywords("refactor all auth handlers", SCOPE_KEYWORDS, MUTATION_VERBS)).toBe(1)
  })

  test("does NOT fire without mutation verb", () => {
    expect(extractP3ScopeKeywords("make sure all tests pass", SCOPE_KEYWORDS, MUTATION_VERBS)).toBe(0)
  })

  test("counts multiple unique keywords", () => {
    expect(extractP3ScopeKeywords("rename every import across all packages", SCOPE_KEYWORDS, MUTATION_VERBS)).toBe(3)
  })

  test("caps at 3", () => {
    expect(extractP3ScopeKeywords(
      "refactor all every entire whole throughout codebase-wide", SCOPE_KEYWORDS, MUTATION_VERBS
    )).toBe(3)
  })
})

describe("P4_conjunction_chains", () => {
  test("read and tell = 0 (no mutation verbs)", () => {
    expect(extractP4ConjunctionChains("read the file and tell me what it does", MUTATION_VERBS)).toBe(0)
  })

  test("refactor and rename = 1 extra clause", () => {
    expect(extractP4ConjunctionChains("refactor the auth module and rename the exports", MUTATION_VERBS)).toBe(1)
  })

  test("refactor and rename and remove = 2", () => {
    expect(extractP4ConjunctionChains("refactor X and rename Y and remove Z", MUTATION_VERBS)).toBe(2)
  })

  test("caps at 3", () => {
    expect(extractP4ConjunctionChains(
      "refactor A and rename B and update C and delete D and move E", MUTATION_VERBS
    )).toBe(3)
  })
})

describe("P5_explicit_path_count", () => {
  const projectDirs = ["src", "packages", "lib"]

  test("detects paths with file extensions", () => {
    expect(extractP5ExplicitPaths("fix src/auth/login.ts", projectDirs)).toBe(1)
  })

  test("detects paths starting with project-dir prefix", () => {
    expect(extractP5ExplicitPaths("update packages/core/ and lib/utils/", projectDirs)).toBe(2)
  })

  test("rejects URLs", () => {
    expect(extractP5ExplicitPaths("check http://example.com/path", projectDirs)).toBe(0)
  })

  test("rejects and/or", () => {
    expect(extractP5ExplicitPaths("this and/or that", projectDirs)).toBe(0)
  })

  test("caps at 4", () => {
    expect(extractP5ExplicitPaths(
      "fix src/a.ts src/b.ts src/c.ts src/d.ts src/e.ts", projectDirs
    )).toBe(4)
  })
})

describe("P6 classifyArchetype", () => {
  const mutationVerbs = ["refactor", "migrate", "rename", "update", "add", "remove",
    "delete", "replace", "convert", "extract", "move"]

  test("read-only: explain, describe", () => {
    expect(classifyArchetype("explain how auth works", mutationVerbs)).toBe("read-only")
    expect(classifyArchetype("describe the architecture", mutationVerbs)).toBe("read-only")
    expect(classifyArchetype("what does this function do?", mutationVerbs)).toBe("read-only")
  })

  test("mutating-broad: refactor with scope signals", () => {
    expect(classifyArchetype("refactor all auth handlers", mutationVerbs)).toBe("mutating-broad")
  })

  test("mutating-narrow: add a feature", () => {
    expect(classifyArchetype("add a login button", mutationVerbs)).toBe("mutating-narrow")
  })

  test("trivial: fix a typo", () => {
    expect(classifyArchetype("fix the typo on line 5", mutationVerbs)).toBe("trivial")
  })

  test("read-only verb + mutation verb → NOT read-only", () => {
    expect(classifyArchetype("show me how to refactor all auth", mutationVerbs)).not.toBe("read-only")
    expect(classifyArchetype("explain what to rename in the module", mutationVerbs)).not.toBe("read-only")
  })

  test("question mark + mutation verb → NOT read-only", () => {
    expect(classifyArchetype("can you refactor this?", mutationVerbs)).not.toBe("read-only")
  })

  test("question mark without mutation verb → read-only", () => {
    expect(classifyArchetype("what is this function?", mutationVerbs)).toBe("read-only")
  })
})
