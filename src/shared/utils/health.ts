import { createChildLogger } from './index';

const logger = createChildLogger('health-check');

export interface HealthCheckResult {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: Date;
  uptime: number;
  checks: {
    [key: string]: {
      status: 'pass' | 'fail' | 'warn';
      message?: string;
      responseTime?: number;
      details?: Record<string, unknown>;
    };
  };
  version?: string;
}

export interface HealthCheck {
  name: string;
  check: () => Promise<{
    status: 'pass' | 'fail' | 'warn';
    message?: string;
    details?: Record<string, unknown>;
  }>;
  critical?: boolean; // If true, failure makes overall status unhealthy
}

export class HealthChecker {
  private checks: Map<string, HealthCheck> = new Map();
  private startTime: Date = new Date();
  private version: string;

  constructor(version = '0.1.0') {
    this.version = version;
  }

  registerCheck(check: HealthCheck): void {
    this.checks.set(check.name, check);
    logger.debug({ checkName: check.name }, 'Health check registered');
  }

  async runChecks(): Promise<HealthCheckResult> {
    const checkResults: HealthCheckResult['checks'] = {};
    let hasFailure = false;
    let hasWarning = false;

    for (const [name, check] of this.checks) {
      const startTime = Date.now();

      try {
        const result = await Promise.race([
          check.check(),
          new Promise<{ status: 'fail'; message: string }>((_, reject) =>
            setTimeout(() => reject(new Error('Health check timeout')), 5000)
          ),
        ]);

        const responseTime = Date.now() - startTime;

        checkResults[name] = {
          ...result,
          responseTime,
        };

        if (result.status === 'fail') {
          hasFailure = hasFailure || (check.critical ?? false);
          logger.warn(
            { checkName: name, message: result.message },
            'Health check failed'
          );
        } else if (result.status === 'warn') {
          hasWarning = true;
        }
      } catch (error) {
        const responseTime = Date.now() - startTime;
        checkResults[name] = {
          status: 'fail',
          message: error instanceof Error ? error.message : 'Unknown error',
          responseTime,
        };

        if (check.critical ?? false) {
          hasFailure = true;
        }

        logger.error(
          { checkName: name, error },
          'Health check threw exception'
        );
      }
    }

    const status = hasFailure
      ? 'unhealthy'
      : hasWarning
      ? 'degraded'
      : 'healthy';

    const uptime = Date.now() - this.startTime.getTime();

    return {
      status,
      timestamp: new Date(),
      uptime,
      checks: checkResults,
      version: this.version,
    };
  }

  getUptime(): number {
    return Date.now() - this.startTime.getTime();
  }

  reset(): void {
    this.startTime = new Date();
  }
}

/**
 * Common health check implementations
 */
export const CommonHealthChecks = {
  /**
   * Check if environment variables are set
   */
  envVars: (requiredVars: string[]): HealthCheck => ({
    name: 'environment',
    critical: true,
    check: async () => {
      const missing = requiredVars.filter((v) => !process.env[v]);

      if (missing.length > 0) {
        return {
          status: 'fail',
          message: `Missing required environment variables: ${missing.join(', ')}`,
          details: { missing },
        };
      }

      return {
        status: 'pass',
        message: 'All required environment variables present',
      };
    },
  }),

  /**
   * Check memory usage
   */
  memory: (warnThresholdMB = 500, criticalThresholdMB = 1000): HealthCheck => ({
    name: 'memory',
    critical: false,
    check: async () => {
      const usage = process.memoryUsage();
      const usedMB = Math.round(usage.heapUsed / 1024 / 1024);

      if (usedMB > criticalThresholdMB) {
        return {
          status: 'fail',
          message: `Memory usage critical: ${usedMB}MB`,
          details: {
            heapUsedMB: usedMB,
            heapTotalMB: Math.round(usage.heapTotal / 1024 / 1024),
            rssMB: Math.round(usage.rss / 1024 / 1024),
          },
        };
      }

      if (usedMB > warnThresholdMB) {
        return {
          status: 'warn',
          message: `Memory usage elevated: ${usedMB}MB`,
          details: {
            heapUsedMB: usedMB,
            heapTotalMB: Math.round(usage.heapTotal / 1024 / 1024),
            rssMB: Math.round(usage.rss / 1024 / 1024),
          },
        };
      }

      return {
        status: 'pass',
        message: `Memory usage normal: ${usedMB}MB`,
        details: {
          heapUsedMB: usedMB,
          heapTotalMB: Math.round(usage.heapTotal / 1024 / 1024),
          rssMB: Math.round(usage.rss / 1024 / 1024),
        },
      };
    },
  }),

  /**
   * Check external service connectivity
   */
  externalService: (
    name: string,
    url: string,
    critical = false
  ): HealthCheck => ({
    name: `service:${name}`,
    critical,
    check: async () => {
      try {
        const response = await fetch(url, {
          method: 'GET',
          signal: AbortSignal.timeout(3000),
        });

        if (response.ok) {
          return {
            status: 'pass',
            message: `${name} is reachable`,
            details: { url, statusCode: response.status },
          };
        }

        return {
          status: critical ? 'fail' : 'warn',
          message: `${name} returned ${response.status}`,
          details: { url, statusCode: response.status },
        };
      } catch (error) {
        return {
          status: critical ? 'fail' : 'warn',
          message: `${name} is unreachable: ${error instanceof Error ? error.message : 'Unknown error'}`,
          details: { url, error: String(error) },
        };
      }
    },
  }),

  /**
   * Check circuit breaker state
   */
  circuitBreaker: (
    name: string,
    getState: () => 'closed' | 'open' | 'half-open'
  ): HealthCheck => ({
    name: `circuit:${name}`,
    critical: false,
    check: async () => {
      const state = getState();

      if (state === 'open') {
        return {
          status: 'warn',
          message: `Circuit breaker for ${name} is OPEN (service unavailable)`,
          details: { state },
        };
      }

      if (state === 'half-open') {
        return {
          status: 'warn',
          message: `Circuit breaker for ${name} is HALF-OPEN (testing recovery)`,
          details: { state },
        };
      }

      return {
        status: 'pass',
        message: `Circuit breaker for ${name} is CLOSED (healthy)`,
        details: { state },
      };
    },
  }),

  /**
   * Check rate limiter availability
   */
  rateLimiter: (
    name: string,
    getAvailableTokens: () => number,
    minTokens = 1
  ): HealthCheck => ({
    name: `rate-limit:${name}`,
    critical: false,
    check: async () => {
      const available = getAvailableTokens();

      if (available < minTokens) {
        return {
          status: 'warn',
          message: `Rate limiter for ${name} is exhausted`,
          details: { availableTokens: available },
        };
      }

      return {
        status: 'pass',
        message: `Rate limiter for ${name} has capacity`,
        details: { availableTokens: Math.floor(available) },
      };
    },
  }),
};
