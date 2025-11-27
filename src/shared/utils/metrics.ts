import { createChildLogger } from './index';

const logger = createChildLogger('metrics');

export interface MetricPoint {
  name: string;
  value: number;
  tags?: Record<string, string>;
  timestamp: number;
}

export interface HistogramBucket {
  le: number; // Less than or equal to
  count: number;
}

export class MetricsCollector {
  private counters: Map<string, number> = new Map();
  private gauges: Map<string, number> = new Map();
  private histograms: Map<string, number[]> = new Map();
  private lastFlush: number = Date.now();

  /**
   * Increment a counter metric
   */
  increment(name: string, value = 1, tags?: Record<string, string>): void {
    const key = this.buildKey(name, tags);
    const current = this.counters.get(key) || 0;
    this.counters.set(key, current + value);
  }

  /**
   * Decrement a counter metric
   */
  decrement(name: string, value = 1, tags?: Record<string, string>): void {
    this.increment(name, -value, tags);
  }

  /**
   * Set a gauge metric (current value)
   */
  gauge(name: string, value: number, tags?: Record<string, string>): void {
    const key = this.buildKey(name, tags);
    this.gauges.set(key, value);
  }

  /**
   * Record a value for histogram (for latency, response sizes, etc.)
   */
  histogram(name: string, value: number, tags?: Record<string, string>): void {
    const key = this.buildKey(name, tags);
    const values = this.histograms.get(key) || [];
    values.push(value);
    this.histograms.set(key, values);
  }

  /**
   * Record timing in milliseconds
   */
  timing(name: string, durationMs: number, tags?: Record<string, string>): void {
    this.histogram(`${name}.duration_ms`, durationMs, tags);
  }

  /**
   * Get all current metrics
   */
  getMetrics(): {
    counters: Map<string, number>;
    gauges: Map<string, number>;
    histograms: Map<string, MetricHistogram>;
  } {
    const histograms = new Map<string, MetricHistogram>();

    for (const [key, values] of this.histograms.entries()) {
      if (values.length === 0) continue;

      const sorted = [...values].sort((a, b) => a - b);
      const sum = sorted.reduce((acc, val) => acc + val, 0);
      const count = sorted.length;

      histograms.set(key, {
        count,
        sum,
        min: sorted[0],
        max: sorted[sorted.length - 1],
        mean: sum / count,
        p50: this.percentile(sorted, 0.5),
        p95: this.percentile(sorted, 0.95),
        p99: this.percentile(sorted, 0.99),
      });
    }

    return {
      counters: new Map(this.counters),
      gauges: new Map(this.gauges),
      histograms,
    };
  }

  /**
   * Get metrics as a plain object (for API responses)
   */
  getMetricsObject(): {
    counters: Record<string, number>;
    gauges: Record<string, number>;
    histograms: Record<string, MetricHistogram>;
    uptime: number;
  } {
    const metrics = this.getMetrics();

    return {
      counters: Object.fromEntries(metrics.counters),
      gauges: Object.fromEntries(metrics.gauges),
      histograms: Object.fromEntries(metrics.histograms),
      uptime: Date.now() - this.lastFlush,
    };
  }

  /**
   * Reset all metrics (useful for periodic flushing)
   */
  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
    this.lastFlush = Date.now();
    logger.debug('Metrics reset');
  }

  /**
   * Flush metrics to logs and optionally reset
   */
  flush(reset = false): void {
    const metrics = this.getMetrics();

    logger.info(
      {
        counters: Object.fromEntries(metrics.counters),
        gauges: Object.fromEntries(metrics.gauges),
        histograms: Object.fromEntries(metrics.histograms),
      },
      'Metrics snapshot'
    );

    if (reset) {
      this.reset();
    }
  }

  private buildKey(name: string, tags?: Record<string, string>): string {
    if (!tags || Object.keys(tags).length === 0) {
      return name;
    }

    const tagString = Object.entries(tags)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}:${v}`)
      .join(',');

    return `${name}{${tagString}}`;
  }

  private percentile(sortedValues: number[], p: number): number {
    if (sortedValues.length === 0) return 0;

    const index = Math.ceil(sortedValues.length * p) - 1;
    return sortedValues[Math.max(0, index)];
  }
}

export interface MetricHistogram {
  count: number;
  sum: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
}

/**
 * Global metrics collector instance
 */
export const metrics = new MetricsCollector();

/**
 * Helper to measure execution time of async functions
 */
export async function measureAsync<T>(
  metricName: string,
  fn: () => Promise<T>,
  tags?: Record<string, string>
): Promise<T> {
  const start = Date.now();
  let error: Error | null = null;

  try {
    const result = await fn();
    metrics.increment(`${metricName}.success`, 1, tags);
    return result;
  } catch (err) {
    error = err as Error;
    metrics.increment(`${metricName}.error`, 1, {
      ...tags,
      error: error.name,
    });
    throw err;
  } finally {
    const duration = Date.now() - start;
    metrics.timing(metricName, duration, tags);
  }
}

/**
 * Helper to measure execution time of sync functions
 */
export function measureSync<T>(
  metricName: string,
  fn: () => T,
  tags?: Record<string, string>
): T {
  const start = Date.now();
  let error: Error | null = null;

  try {
    const result = fn();
    metrics.increment(`${metricName}.success`, 1, tags);
    return result;
  } catch (err) {
    error = err as Error;
    metrics.increment(`${metricName}.error`, 1, {
      ...tags,
      error: error.name,
    });
    throw err;
  } finally {
    const duration = Date.now() - start;
    metrics.timing(metricName, duration, tags);
  }
}

/**
 * Middleware factory for Express to track HTTP metrics
 */
export function createMetricsMiddleware() {
  return (req: any, res: any, next: () => void) => {
    const start = Date.now();

    res.on('finish', () => {
      const duration = Date.now() - start;
      const tags = {
        method: req.method,
        path: req.route?.path || req.path,
        status: String(res.statusCode),
      };

      metrics.increment('http.requests', 1, tags);
      metrics.timing('http.request', duration, tags);

      if (res.statusCode >= 400) {
        metrics.increment('http.errors', 1, tags);
      }
    });

    next();
  };
}
