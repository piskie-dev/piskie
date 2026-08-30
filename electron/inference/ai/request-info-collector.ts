export interface AiRunStatistics {
  firstVisibleContentLatencyMs?: number;
  generationDurationMs?: number;
}

/** Keeps absolute timestamps private to one Gateway run. */
export class AIRequestInfoCollector {
  private attemptStartedAt?: number;
  private firstVisibleContentAt?: number;
  private firstVisibleContentLatencyMs?: number;

  onAttemptStarted(at: number): void {
    this.attemptStartedAt = at;
    this.firstVisibleContentAt = undefined;
    this.firstVisibleContentLatencyMs = undefined;
  }

  onVisibleContent(at: number): void {
    if (this.firstVisibleContentAt !== undefined) return;
    this.firstVisibleContentAt = at;
    if (this.attemptStartedAt !== undefined) {
      this.firstVisibleContentLatencyMs = at - this.attemptStartedAt;
    }
  }

  complete(at: number): AiRunStatistics {
    return {
      ...(this.firstVisibleContentLatencyMs !== undefined && {
        firstVisibleContentLatencyMs: this.firstVisibleContentLatencyMs,
      }),
      ...(this.firstVisibleContentAt !== undefined && {
        generationDurationMs: at - this.firstVisibleContentAt,
      }),
    };
  }
}
