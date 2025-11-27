import pino from 'pino';
import { randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';

const isDev = process.env.NODE_ENV !== 'production';

// AsyncLocalStorage for correlation ID propagation
export const correlationIdStorage = new AsyncLocalStorage<string>();

export const logger = pino({
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
  transport: isDev
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
  base: {
    service: 'jarvis',
    env: process.env.NODE_ENV || 'development',
  },
  // Add correlation ID to all logs automatically
  mixin() {
    const correlationId = correlationIdStorage.getStore();
    return correlationId ? { correlationId } : {};
  },
  // Serialize errors properly
  serializers: {
    error: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },
});

export const createChildLogger = (component: string) =>
  logger.child({ component });

/**
 * Execute a function with a correlation ID
 * All logs within this context will include the correlation ID
 */
export function withCorrelationId<T>(
  correlationId: string,
  fn: () => T | Promise<T>
): T | Promise<T> {
  return correlationIdStorage.run(correlationId, fn);
}

/**
 * Generate a new correlation ID
 */
export function generateCorrelationId(): string {
  return randomUUID();
}

/**
 * Get the current correlation ID from context
 */
export function getCorrelationId(): string | undefined {
  return correlationIdStorage.getStore();
}

/**
 * Create a logger with additional context fields
 */
export function createContextLogger(
  component: string,
  context: Record<string, unknown>
) {
  return logger.child({ component, ...context });
}
