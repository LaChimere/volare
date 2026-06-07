import { toVolareError } from '../core/errors';
import type { ILogFields, ILogger } from '../logging/logger';
import type {
  IOpenAIResponsesStreamFrame,
  IOpenAIResponsesStreamObserver,
  OpenAIResponseOutcome,
} from '../northbound/openai-responses/adapter';

type StreamInterruptionReason = 'client_disconnect' | 'server_aborted' | 'unknown';
type StreamInterruptionPhase = 'pre_first_sse_frame' | 'pre_terminal' | 'post_terminal' | 'unknown';

export class StreamLifecycleContext implements IOpenAIResponsesStreamObserver {
  readonly #logger: ILogger;
  #responseCreatedAt = performance.now();
  #firstPullAt: number | undefined;
  #firstSseAt: number | undefined;
  #firstAssistantSseAt: number | undefined;
  #terminalOutcome: OpenAIResponseOutcome | undefined;
  #doneAt: number | undefined;
  #frameCount = 0;
  #cancelled: { reason: StreamInterruptionReason; phase: StreamInterruptionPhase } | undefined;
  #cleanupErrorCode: string | undefined;
  #finalized = false;

  constructor(logger: ILogger) {
    this.#logger = logger;
  }

  recordResponseCreated(): void {
    this.#responseCreatedAt = performance.now();
  }

  recordFirstPull(): void {
    this.#firstPullAt ??= performance.now();
  }

  recordCancellation(reason: StreamInterruptionReason): void {
    this.#cancelled ??= { reason, phase: this.#interruptionPhase() };
  }

  onFrame(frame: IOpenAIResponsesStreamFrame): void {
    const observedAt = performance.now();
    this.#firstSseAt ??= observedAt;
    this.#frameCount += 1;
    if (frame.assistantContent) {
      this.#firstAssistantSseAt ??= observedAt;
    }
    if (frame.terminalOutcome) {
      this.#terminalOutcome = frame.terminalOutcome;
    }
    if (frame.done) {
      this.#doneAt = observedAt;
    }
  }

  finalizeCleanReturn(): void {
    if (this.#terminalOutcome && this.#doneAt !== undefined) {
      this.#finalizeCompleted();
      return;
    }
    if (this.#cancelled) {
      this.#finalizeInterrupted();
      return;
    }
    this.#finalizeFailed('backend_ended_without_terminal');
  }

  finalizeError(error: unknown): void {
    const errorCode = toVolareError(error).code;
    if (this.#cancelled) {
      this.#cleanupErrorCode = errorCode;
      this.#finalizeInterrupted();
      return;
    }
    this.#finalizeFailed(errorCode);
  }

  #finalizeCompleted(): void {
    if (!this.#claimFinalized()) {
      return;
    }
    this.#logger.info(
      {
        event: 'responses.stream.completed',
        responseOutcome: this.#terminalOutcome ?? 'unknown',
        ...this.#baseFields(),
        ...(this.#firstSseAt !== undefined && this.#doneAt !== undefined
          ? { sseActiveMs: elapsedBetweenMs(this.#firstSseAt, this.#doneAt) }
          : {}),
      },
      'responses stream completed',
    );
  }

  #finalizeInterrupted(): void {
    if (!this.#claimFinalized()) {
      return;
    }
    const cancelled = this.#cancelled;
    this.#logger.warn(
      {
        event: 'responses.stream.interrupted',
        interruptionReason: cancelled?.reason ?? 'unknown',
        interruptionPhase: cancelled?.phase ?? 'unknown',
        ...this.#baseFields(),
        ...(this.#cleanupErrorCode ? { cleanupErrorCode: this.#cleanupErrorCode } : {}),
      },
      'responses stream interrupted',
    );
  }

  #finalizeFailed(errorCode: string): void {
    if (!this.#claimFinalized()) {
      return;
    }
    const failedAt = performance.now();
    this.#logger.error(
      {
        event: 'responses.stream.failed',
        errorCode,
        ...this.#baseFields(),
        ...(this.#firstSseAt !== undefined
          ? { sseActiveMs: elapsedBetweenMs(this.#firstSseAt, failedAt) }
          : {}),
      },
      'responses stream failed',
    );
  }

  #baseFields(): ILogFields {
    return {
      sseFrameCount: this.#frameCount,
      ...(this.#firstPullAt !== undefined
        ? { streamStartGapMs: elapsedBetweenMs(this.#responseCreatedAt, this.#firstPullAt) }
        : {}),
      ...(this.#firstPullAt !== undefined && this.#firstAssistantSseAt !== undefined
        ? {
            firstAssistantSseFrameMs: elapsedBetweenMs(
              this.#firstPullAt,
              this.#firstAssistantSseAt,
            ),
          }
        : {}),
    };
  }

  #interruptionPhase(): StreamInterruptionPhase {
    if (this.#firstSseAt === undefined) {
      return 'pre_first_sse_frame';
    }
    if (this.#terminalOutcome && this.#doneAt === undefined) {
      return 'post_terminal';
    }
    if (!this.#terminalOutcome) {
      return 'pre_terminal';
    }
    return 'unknown';
  }

  #claimFinalized(): boolean {
    if (this.#finalized) {
      return false;
    }
    this.#finalized = true;
    return true;
  }
}

function elapsedBetweenMs(startedAt: number, endedAt: number): number {
  return Math.round(endedAt - startedAt);
}
