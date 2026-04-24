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

  test("does NOT fire on question marks in natural language", () => {
    expect(extractP1GlobMentions("what does this do?")).toBe(0)
    expect(extractP1GlobMentions("is this correct?")).toBe(0)
  })

  test("does NOT fire on code syntax like {} or [] or ?.foo", () => {
    expect(extractP1GlobMentions("function foo() {} returns void")).toBe(0)
    expect(extractP1GlobMentions("access arr[0] and obj?.foo")).toBe(0)
    expect(extractP1GlobMentions("the config is { debug: true }")).toBe(0)
  })

  test("matches brace alternation with ≥2 options", () => {
    expect(extractP1GlobMentions("fix *.{ts,tsx} files")).toBe(1)
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

  test("scoped match has word boundary (no prefix false-positive)", () => {
    // @app/auth should NOT match @app/authentication
    expect(extractP2PackageMentions("fix @app/authentication module", ["@app/auth"])).toBe(0)
    // @app/auth should match @app/auth-utils only if word-chars continue (dash = word char here)
    expect(extractP2PackageMentions("fix @app/auth-utils", ["@app/auth"])).toBe(0)
    // Should still match exact name followed by space/punct
    expect(extractP2PackageMentions("fix @app/auth today", ["@app/auth"])).toBe(1)
    expect(extractP2PackageMentions("fix @app/auth, please", ["@app/auth"])).toBe(1)
  })

  test("scoped match has LEADING word boundary too (symmetric)", () => {
    // "my@app/auth" should NOT match @app/auth (leading word char)
    expect(extractP2PackageMentions("use my@app/auth tokens", ["@app/auth"])).toBe(0)
  })

  test("scoped match works at string boundaries", () => {
    expect(extractP2PackageMentions("@app/auth", ["@app/auth"])).toBe(1)
    expect(extractP2PackageMentions("starts with @app/auth", ["@app/auth"])).toBe(1)
  })

  // Regression: bare non-scoped name must NOT match inside a sibling scoped name.
  // Was firing P2=2 for a single-package prompt on the opencode repo because
  // "opencode" (from packages/opencode/package.json) matched inside the user's
  // "@opencode-ai/app" reference, which inflated C4 and pushed the decision
  // toward coordinator.
  test("bare name does not match inside scoped sibling (@opencode-ai/app vs opencode)", () => {
    const pkgs = ["@opencode-ai/app", "opencode"]
    // User wrote the scoped name — only that one should match
    expect(extractP2PackageMentions("update @opencode-ai/app", pkgs)).toBe(1)
    // Bare name still matches when genuinely mentioned as a standalone word
    expect(extractP2PackageMentions("fix the opencode setup", pkgs)).toBe(1)
    // Slash-path contexts don't false-match either
    expect(extractP2PackageMentions("read opencode/docs/index.md", pkgs)).toBe(0)
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

  test("non-English prompt with no recognized verbs → mutating-narrow (neutral, not trivial)", () => {
    // Chinese: "Refactor all auth modules"
    expect(classifyArchetype("重构所有认证模块并更新配置", mutationVerbs)).toBe("mutating-narrow")
    // Should NOT be classified as trivial (which would force single)
    expect(classifyArchetype("重构所有认证模块并更新配置", mutationVerbs)).not.toBe("trivial")
  })

  test("short ASCII prompt with no verbs still trivial (no change)", () => {
    expect(classifyArchetype("ok thanks", mutationVerbs)).toBe("trivial")
  })

  // v1.6: "translate" and "rewrite" added to mutationVerbs (Phase C finding #2
  // follow-up). "port" was evaluated and rejected — substring collision with
  // "export" / "import" / "transport" makes it too noisy under the current
  // substring-match approach.
  test("new verbs: translate + rewrite fire as mutation", () => {
    const extendedVerbs = [...mutationVerbs, "translate", "rewrite"]
    expect(classifyArchetype("translate the API layer to gRPC", extendedVerbs)).toBe("mutating-narrow")
    expect(classifyArchetype("rewrite the error handling module", extendedVerbs)).toBe("mutating-narrow")
    // with scope keyword → mutating-broad
    expect(classifyArchetype("rewrite every module in the entire codebase", extendedVerbs)).toBe("mutating-broad")
  })

  test("new verbs: read-only verb + translate → NOT read-only", () => {
    const extendedVerbs = [...mutationVerbs, "translate", "rewrite"]
    expect(classifyArchetype("explain how to translate this module", extendedVerbs)).not.toBe("read-only")
  })
})
