/**
 * Kill ring — emacs-style cut buffer with accumulation and yank-pop cycling.
 *
 * Stores up to MAX_SIZE killed text entries. Consecutive kills in the same
 * direction accumulate into a single entry. Yank retrieves the most recent
 * entry; yank-pop cycles backward through the ring.
 */

const MAX_SIZE = 10

export class KillRing {
  private entries: string[] = []
  private accumulating = false
  private yankIndex = -1
  private _isYanking = false
  private _lastYankedText: string | undefined = undefined

  /** Whether the ring is currently in yank-cycling mode. */
  get isYanking(): boolean {
    return this._isYanking
  }

  /** The text that was last returned by yank() or yankPop(). */
  get lastYankedText(): string | undefined {
    return this._lastYankedText
  }

  /**
   * Push killed text onto the ring.
   *
   * If accumulating (consecutive kills without a reset), the text is merged
   * with the top entry: "append" concatenates to the end, "prepend" prepends
   * to the start. Otherwise a new entry is created, evicting the oldest if
   * the ring is full.
   */
  push(text: string, direction: "append" | "prepend"): void {
    if (this.accumulating && this.entries.length > 0) {
      const top = this.entries[this.entries.length - 1]
      this.entries[this.entries.length - 1] =
        direction === "append" ? top + text : text + top
    } else {
      if (this.entries.length >= MAX_SIZE) {
        this.entries.shift()
      }
      this.entries.push(text)
    }
    this.accumulating = true
  }

  /**
   * Return the most recent kill ring entry and enter yanking mode.
   * Returns undefined if the ring is empty.
   */
  yank(): string | undefined {
    if (this.entries.length === 0) return undefined
    this.yankIndex = this.entries.length - 1
    this._isYanking = true
    this._lastYankedText = this.entries[this.yankIndex]
    return this._lastYankedText
  }

  /**
   * Cycle to the next older entry in the ring (wrapping around).
   * Must be called after yank(). Returns undefined if ring is empty
   * or not in yanking state.
   */
  yankPop(): string | undefined {
    if (!this._isYanking || this.entries.length === 0) return undefined
    this.yankIndex =
      (this.yankIndex - 1 + this.entries.length) % this.entries.length
    this._lastYankedText = this.entries[this.yankIndex]
    return this._lastYankedText
  }

  /** Stop consecutive-kill accumulation (called on non-kill keystrokes). */
  resetAccumulation(): void {
    this.accumulating = false
  }

  /** Exit yank-cycling mode (called on non-yank keystrokes). */
  resetYankState(): void {
    this._isYanking = false
    this._lastYankedText = undefined
    this.yankIndex = -1
  }
}
