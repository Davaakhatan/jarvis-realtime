import { createChildLogger } from './index';

const logger = createChildLogger('retry-utility');

export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  retryableErrors?: Array<new (...args: any[]) => Error>;
  onRetry?: (error: Error, attempt: number) => void;
  timeout?: number;
}

export class RetryableError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = 'RetryableError';
  }
}

export class NonRetryableError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = 'NonRetryableError';
  }
}

export class TimeoutError extends Error {
  constructor(message: string, public readonly timeoutMs: number) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Executes a function with exponential backoff retry logic
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelayMs = 1000,
    maxDelayMs = 10000,
    backoffMultiplier = 2,
    retryableErrors = [RetryableError],
    onRetry,
    timeout,
  } = options;

  let lastError: Error;
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt++;

    try {
      if (timeout) {
        return await withTimeout(fn(), timeout);
      }
      return await fn();
    } catch (error) {
      lastError = error as Error;

      // Check if error is non-retryable
      if (error instanceof NonRetryableError) {
        logger.error({ error, attempt }, 'Non-retryable error encountered');
        throw error;
      }

      // Check if we should retry
      const shouldRetry =
        attempt < maxAttempts &&
        retryableErrors.some((errorClass) => error instanceof errorClass);

      if (!shouldRetry) {
        if (attempt >= maxAttempts) {
          logger.error({ error, attempt }, 'Max retry attempts reached');
        } else {
          logger.error({ error, attempt }, 'Non-retryable error type');
        }
        throw error;
      }

      // Calculate delay with exponential backoff
      const delay = Math.min(
        initialDelayMs * Math.pow(backoffMultiplier, attempt - 1),
        maxDelayMs
      );

      logger.warn(
        { error: lastError.message, attempt, maxAttempts, delayMs: delay },
        'Retrying after error'
      );

      if (onRetry) {
        onRetry(lastError, attempt);
      }

      await sleep(delay);
    }
  }

  throw lastError!;
}

/**
 * Wraps a promise with a timeout
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => {
        reject(
          new TimeoutError(
            `Operation timed out after ${timeoutMs}ms`,
            timeoutMs
          )
        );
      }, timeoutMs);
    }),
  ]);
}

/**
 * Circuit breaker implementation
 */
export class CircuitBreaker {
  private failureCount = 0;
  private lastFailureTime = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';

  constructor(
    private readonly options: {
      failureThreshold: number;
      resetTimeoutMs: number;
      halfOpenMaxAttempts?: number;
    }
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      const timeSinceLastFailure = Date.now() - this.lastFailureTime;

      if (timeSinceLastFailure >= this.options.resetTimeoutMs) {
        logger.info('Circuit breaker transitioning to half-open');
        this.state = 'half-open';
      } else {
        throw new Error(
          'Circuit breaker is open - too many recent failures'
        );
      }
    }

    try {
      const result = await fn();

      // Success - reset if we were in half-open state
      if (this.state === 'half-open') {
        logger.info('Circuit breaker closing after successful half-open attempt');
        this.close();
      }

      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  private recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.failureCount >= this.options.failureThreshold) {
      logger.warn(
        { failureCount: this.failureCount, threshold: this.options.failureThreshold },
        'Circuit breaker opening due to failures'
      );
      this.state = 'open';
    }
  }

  private close(): void {
    this.state = 'closed';
    this.failureCount = 0;
    this.lastFailureTime = 0;
  }

  getState(): 'closed' | 'open' | 'half-open' {
    return this.state;
  }

  reset(): void {
    this.close();
  }
}

/**
 * Rate limiter implementation using token bucket algorithm
 */
export class RateLimiter {
  private tokens: number;
  private lastRefillTime: number;

  constructor(
    private readonly tokensPerInterval: number,
    private readonly intervalMs: number,
    private readonly burstSize?: number
  ) {
    this.tokens = burstSize || tokensPerInterval;
    this.lastRefillTime = Date.now();
  }

  async acquire(tokens = 1): Promise<void> {
    this.refill();

    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return;
    }

    // Wait until we have enough tokens
    const waitTime = this.calculateWaitTime(tokens);
    await sleep(waitTime);
    this.refill();
    this.tokens -= tokens;
  }

  private refill(): void {
    const now = Date.now();
    const timePassed = now - this.lastRefillTime;
    const tokensToAdd =
      (timePassed / this.intervalMs) * this.tokensPerInterval;

    const maxTokens = this.burstSize || this.tokensPerInterval;
    this.tokens = Math.min(this.tokens + tokensToAdd, maxTokens);
    this.lastRefillTime = now;
  }

  private calculateWaitTime(tokensNeeded: number): number {
    const tokensShort = tokensNeeded - this.tokens;
    return (tokensShort / this.tokensPerInterval) * this.intervalMs;
  }

  getAvailableTokens(): number {
    this.refill();
    return this.tokens;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
