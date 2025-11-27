import { EventEmitter } from 'events';
import { createChildLogger } from '../../shared/utils/index';

const logger = createChildLogger('api-poller');

export interface APIEndpoint {
  id: string;
  name: string;
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  intervalMs?: number;
  transform?: (data: unknown) => unknown;
}

export interface CachedData {
  endpointId: string;
  data: unknown;
  fetchedAt: Date;
  expiresAt: Date;
}

export interface APIPollerConfig {
  defaultIntervalMs: number;
  maxRetries: number;
  retryDelayMs: number;
}

export class APIPoller extends EventEmitter {
  private config: APIPollerConfig;
  private endpoints: Map<string, APIEndpoint> = new Map();
  private cache: Map<string, CachedData> = new Map();
  private pollers: Map<string, ReturnType<typeof setInterval>> = new Map();

  constructor(config: Partial<APIPollerConfig> = {}) {
    super();
    this.config = {
      defaultIntervalMs: 180000, // 3 minutes
      maxRetries: 3,
      retryDelayMs: 1000,
      ...config,
    };
  }

  registerEndpoint(endpoint: APIEndpoint): void {
    this.endpoints.set(endpoint.id, {
      method: 'GET',
      intervalMs: this.config.defaultIntervalMs,
      ...endpoint,
    });
    logger.info({ endpointId: endpoint.id, name: endpoint.name }, 'Endpoint registered');
  }

  unregisterEndpoint(endpointId: string): void {
    this.stopPolling(endpointId);
    this.endpoints.delete(endpointId);
    this.cache.delete(endpointId);
    logger.info({ endpointId }, 'Endpoint unregistered');
  }

  startPolling(endpointId: string): void {
    const endpoint = this.endpoints.get(endpointId);
    if (!endpoint) {
      logger.warn({ endpointId }, 'Endpoint not found');
      return;
    }

    if (this.pollers.has(endpointId)) {
      logger.debug({ endpointId }, 'Already polling');
      return;
    }

    // Fetch immediately
    this.fetchEndpoint(endpointId);

    // Set up interval
    const interval = setInterval(() => {
      this.fetchEndpoint(endpointId);
    }, endpoint.intervalMs);

    this.pollers.set(endpointId, interval);
    logger.info({ endpointId, intervalMs: endpoint.intervalMs }, 'Started polling');
  }

  stopPolling(endpointId: string): void {
    const interval = this.pollers.get(endpointId);
    if (interval) {
      clearInterval(interval);
      this.pollers.delete(endpointId);
      logger.info({ endpointId }, 'Stopped polling');
    }
  }

  startAllPolling(): void {
    for (const endpointId of this.endpoints.keys()) {
      this.startPolling(endpointId);
    }
  }

  stopAllPolling(): void {
    for (const endpointId of this.pollers.keys()) {
      this.stopPolling(endpointId);
    }
  }

  getData(endpointId: string): unknown | null {
    const cached = this.cache.get(endpointId);
    if (!cached) return null;

    if (new Date() > cached.expiresAt) {
      logger.debug({ endpointId }, 'Cache expired');
      return null;
    }

    return cached.data;
  }

  getAllData(): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [endpointId, cached] of this.cache) {
      if (new Date() <= cached.expiresAt) {
        result[endpointId] = cached.data;
      }
    }

    return result;
  }

  private async fetchEndpoint(endpointId: string): Promise<void> {
    const endpoint = this.endpoints.get(endpointId);
    if (!endpoint) return;

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        const response = await fetch(endpoint.url, {
          method: endpoint.method,
          headers: endpoint.headers,
          body: endpoint.body ? JSON.stringify(endpoint.body) : undefined,
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        let data = await response.json();

        if (endpoint.transform) {
          data = endpoint.transform(data);
        }

        const now = new Date();
        const cached: CachedData = {
          endpointId,
          data,
          fetchedAt: now,
          expiresAt: new Date(now.getTime() + (endpoint.intervalMs || this.config.defaultIntervalMs)),
        };

        this.cache.set(endpointId, cached);
        this.emit('data', { endpointId, data });

        logger.debug({ endpointId, attempt }, 'Fetch successful');
        return;
      } catch (error) {
        lastError = error as Error;
        logger.warn({ endpointId, attempt, error }, 'Fetch failed');

        if (attempt < this.config.maxRetries) {
          await this.sleep(this.config.retryDelayMs * attempt);
        }
      }
    }

    this.emit('error', { endpointId, error: lastError });
    logger.error({ endpointId, error: lastError }, 'All fetch attempts failed');
  }

  async forceRefresh(endpointId: string): Promise<unknown | null> {
    await this.fetchEndpoint(endpointId);
    return this.getData(endpointId);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Tool definition for LLM integration
export const apiPollerTools = [
  {
    name: 'get_api_data',
    description: 'Get cached data from a registered API endpoint',
    parameters: {
      type: 'object',
      properties: {
        endpoint_id: {
          type: 'string',
          description: 'The ID of the API endpoint to get data from',
        },
      },
      required: ['endpoint_id'],
    },
  },
  {
    name: 'refresh_api_data',
    description: 'Force refresh data from an API endpoint',
    parameters: {
      type: 'object',
      properties: {
        endpoint_id: {
          type: 'string',
          description: 'The ID of the API endpoint to refresh',
        },
      },
      required: ['endpoint_id'],
    },
  },
  {
    name: 'list_available_apis',
    description: 'List all available API endpoints and their current data status',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
];
