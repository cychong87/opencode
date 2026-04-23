export class ErrorBudgetTracker {
  private readonly threshold: number
  private readonly windowSize: number
  private turns: Array<{ fallbackPath: string | null }> = []
  private bannerShownInWindow = false

  constructor(threshold: number = 4, windowSize: number = 20) {
    this.threshold = threshold
    this.windowSize = windowSize
  }

  recordTurn(fallbackPath: string | null): void {
    this.turns.push({ fallbackPath })
    if (this.turns.length > this.windowSize) {
      this.turns.shift()
      this.bannerShownInWindow = false  // reset when window slides
    }
  }

  shouldShowBanner(): boolean {
    if (this.bannerShownInWindow) return false
    const fallbackCount = this.turns.filter(t => t.fallbackPath !== null).length
    return fallbackCount >= this.threshold
  }

  getBannerMessage(): string {
    const fallbackCount = this.turns.filter(t => t.fallbackPath !== null).length
    return `⚠ Router degraded — ${fallbackCount}/${this.windowSize} recent turns fell back to single-agent mode.\n  Run \`router:health\` for details.`
  }

  bannerShown(): void {
    this.bannerShownInWindow = true
  }
}
