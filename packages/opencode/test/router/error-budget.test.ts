import { describe, test, expect } from "bun:test"
import { ErrorBudgetTracker } from "@/agent/router/error-budget"

describe("ErrorBudgetTracker", () => {
  test("no banner when under threshold", () => {
    const tracker = new ErrorBudgetTracker(4, 20)
    tracker.recordTurn("timeout")
    tracker.recordTurn("timeout")
    tracker.recordTurn("timeout")
    expect(tracker.shouldShowBanner()).toBe(false)
  })

  test("banner fires at threshold", () => {
    const tracker = new ErrorBudgetTracker(4, 20)
    for (let i = 0; i < 4; i++) tracker.recordTurn("timeout")
    expect(tracker.shouldShowBanner()).toBe(true)
    expect(tracker.getBannerMessage()).toContain("4/20")
  })

  test("banner suppressed after shown in same window", () => {
    const tracker = new ErrorBudgetTracker(4, 20)
    for (let i = 0; i < 4; i++) tracker.recordTurn("timeout")
    expect(tracker.shouldShowBanner()).toBe(true)
    tracker.bannerShown()
    tracker.recordTurn("timeout")
    expect(tracker.shouldShowBanner()).toBe(false)
  })

  test("successful turns don't count as fallbacks", () => {
    const tracker = new ErrorBudgetTracker(4, 20)
    for (let i = 0; i < 3; i++) tracker.recordTurn("timeout")
    for (let i = 0; i < 17; i++) tracker.recordTurn(null)
    expect(tracker.shouldShowBanner()).toBe(false)
  })

  test("window slides — old failures drop off", () => {
    const tracker = new ErrorBudgetTracker(4, 5)  // small window for testing
    for (let i = 0; i < 4; i++) tracker.recordTurn("timeout")
    expect(tracker.shouldShowBanner()).toBe(true)
    tracker.bannerShown()
    // Add enough successes to push failures out of window
    for (let i = 0; i < 5; i++) tracker.recordTurn(null)
    expect(tracker.shouldShowBanner()).toBe(false)
  })

  test("banner message contains fallback count", () => {
    const tracker = new ErrorBudgetTracker(2, 10)
    tracker.recordTurn("timeout")
    tracker.recordTurn("circuit_open")
    tracker.recordTurn(null)
    expect(tracker.getBannerMessage()).toContain("2/10")
    expect(tracker.getBannerMessage()).toContain("⚠")
  })

  test("default threshold and window size", () => {
    const tracker = new ErrorBudgetTracker()
    // Default is 4/20, so 3 failures shouldn't trigger
    for (let i = 0; i < 3; i++) tracker.recordTurn("timeout")
    expect(tracker.shouldShowBanner()).toBe(false)
  })

  test("banner does NOT re-fire when window slides but failures still above threshold", () => {
    const tracker = new ErrorBudgetTracker(2, 5)
    tracker.recordTurn("timeout")
    tracker.recordTurn("timeout")
    expect(tracker.shouldShowBanner()).toBe(true)
    tracker.bannerShown()
    // Add one success — window slides, but 2 failures remain
    tracker.recordTurn(null)
    expect(tracker.shouldShowBanner()).toBe(false) // still suppressed
  })

  test("reset clears all state", () => {
    const tracker = new ErrorBudgetTracker(2, 5)
    tracker.recordTurn("timeout")
    tracker.recordTurn("timeout")
    tracker.bannerShown()
    tracker.reset()
    tracker.recordTurn("timeout")
    tracker.recordTurn("timeout")
    expect(tracker.shouldShowBanner()).toBe(true)  // fresh after reset
  })
})
