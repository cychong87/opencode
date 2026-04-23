import { describe, test, expect } from "bun:test"
import { extractP1GlobMentions, extractP2PackageMentions } from "@/agent/router/scorer"

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
