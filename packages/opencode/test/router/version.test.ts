import { describe, test, expect } from "bun:test"
import { computeRouterDecisionVersion, sha256Hex, ROUTER_VERSION, WEIGHTS_VERSION } from "@/agent/router/version"

describe("computeRouterDecisionVersion", () => {
  test("returns a 12-char hex string", () => {
    const v = computeRouterDecisionVersion("abc123")
    expect(v).toHaveLength(12)
    expect(/^[0-9a-f]{12}$/.test(v)).toBe(true)
  })

  test("deterministic: same inputs produce same hash", () => {
    const a = computeRouterDecisionVersion("abc")
    const b = computeRouterDecisionVersion("abc")
    expect(a).toBe(b)
  })

  test("changes when tiebreaker prompt sha changes", () => {
    const a = computeRouterDecisionVersion("aaa")
    const b = computeRouterDecisionVersion("bbb")
    expect(a).not.toBe(b)
  })

  test("exposes ROUTER_VERSION and WEIGHTS_VERSION constants", () => {
    expect(ROUTER_VERSION).toMatch(/^v\d+\.\d+\.\d+$/)
    expect(WEIGHTS_VERSION).toMatch(/^v\d+\.\d+\.\d+$/)
  })
})

describe("sha256Hex", () => {
  test("produces 64-char hex", () => {
    expect(sha256Hex("hello")).toHaveLength(64)
    expect(/^[0-9a-f]{64}$/.test(sha256Hex("hello"))).toBe(true)
  })

  test("known value", () => {
    expect(sha256Hex("hello")).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824")
  })
})
