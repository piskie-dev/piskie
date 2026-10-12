export interface AiRunStatistics {
  firstTokenLatencyMs?: number;
  attemptDurationMs?: number;
}

/** Keeps absolute timestamps private to one Gateway run. */
export class AIRequestInfoCollector {
  private attemptStartedAt?: number;
  private firstTokenAt?: number;
  private firstTokenLatencyMs?: number;

  onAttemptStarted(at: number): void {
    this.attemptStartedAt = at;
    this.firstTokenAt = undefined;
    this.firstTokenLatencyMs = undefined;
  }

  onFirstToken(at: number): void {
    if (this.firstTokenAt !== undefined) return;
    this.firstTokenAt = at;
    if (this.attemptStartedAt !== undefined) {
      this.firstTokenLatencyMs = at - this.attemptStartedAt;
    }
  }

  complete(at: number): AiRunStatistics {
    return {
      ...(this.firstTokenLatencyMs !== undefined && {
        firstTokenLatencyMs: this.firstTokenLatencyMs,
      }),
      ...(this.attemptStartedAt !== undefined && {
        attemptDurationMs: at - this.attemptStartedAt,
      }),
    };
  }
}
