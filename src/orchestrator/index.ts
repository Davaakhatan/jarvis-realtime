import express from 'express';
import path from 'path';
import {
  config,
  logger,
  createChildLogger,
  withCorrelationId,
  generateCorrelationId,
  metrics,
  createMetricsMiddleware,
} from '../shared/utils/index';
import { HealthChecker, CommonHealthChecks } from '../shared/utils/health';
import { SessionManager } from './session-manager';
import { Pipeline } from './pipeline';
import { WebSocketHandler } from './websocket-handler';

const log = createChildLogger('main');
const healthChecker = new HealthChecker('0.1.0');

async function main(): Promise<void> {
  log.info('Starting Jarvis orchestrator...');

  // Validate required configuration
  if (!config.llmApiKey) {
    log.error('LLM_API_KEY is required but not set');
    process.exit(1);
  }

  // Initialize components
  const sessionManager = new SessionManager();
  const pipeline = new Pipeline(sessionManager, {
    maxLatencyMs: config.maxLatencyMs,
    openaiApiKey: config.llmApiKey,
    githubToken: config.githubToken,
  });

  // Start pipeline services
  pipeline.start();

  // Start WebSocket server for real-time communication
  const wsHandler = new WebSocketHandler(
    config.wsPort,
    sessionManager,
    pipeline
  );

  // Register health checks
  healthChecker.registerCheck(
    CommonHealthChecks.envVars(['LLM_API_KEY'])
  );
  healthChecker.registerCheck(CommonHealthChecks.memory(500, 1000));

  // Setup REST API for health checks and management
  const app = express();
  app.use(express.json());

  // Correlation ID middleware - adds correlation ID to all requests
  app.use((req, res, next) => {
    const correlationId =
      (req.headers['x-correlation-id'] as string) || generateCorrelationId();

    // Set correlation ID in response headers
    res.setHeader('X-Correlation-ID', correlationId);

    // Wrap request handling in correlation ID context
    withCorrelationId(correlationId, () => {
      next();
    });
  });

  // Request logging middleware
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      log.info(
        {
          method: req.method,
          path: req.path,
          statusCode: res.statusCode,
          duration,
        },
        'HTTP request completed'
      );
    });
    next();
  });

  // Metrics collection middleware
  app.use(createMetricsMiddleware());

  // Serve static files (test client)
  app.use(express.static(path.join(__dirname, '../../public')));

  // Simple health check - just confirms server is responding
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Detailed health check with service status
  app.get('/health/detailed', async (req, res) => {
    const result = await healthChecker.runChecks();
    const statusCode = result.status === 'healthy' ? 200 : result.status === 'degraded' ? 200 : 503;
    res.status(statusCode).json(result);
  });

  // Readiness check for k8s/load balancers
  app.get('/ready', async (req, res) => {
    const result = await healthChecker.runChecks();
    if (result.status === 'unhealthy') {
      res.status(503).json({ ready: false, reason: 'Service unhealthy' });
    } else {
      res.json({ ready: true, status: result.status });
    }
  });

  // Liveness check for k8s
  app.get('/live', (req, res) => {
    res.json({ alive: true, uptime: healthChecker.getUptime() });
  });

  // Metrics endpoint
  app.get('/metrics', (req, res) => {
    const metricsData = metrics.getMetricsObject();
    res.json(metricsData);
  });

  // API endpoint to register external data sources
  app.post('/api/data-sources', (req, res) => {
    const { id, name, url, intervalMs } = req.body;
    if (!id || !name || !url) {
      res.status(400).json({ error: 'Missing required fields: id, name, url' });
      return;
    }
    // Access pipeline's apiPoller through a method if needed
    res.json({ registered: true, id });
  });

  // Session cleanup interval
  const cleanupInterval = setInterval(() => {
    sessionManager.cleanupStaleSessions(config.sessionTimeoutMs);
  }, 60000);

  // Metrics flush interval (every 5 minutes)
  const metricsInterval = setInterval(() => {
    log.debug('Flushing metrics to logs');
    metrics.flush(false); // Don't reset, keep accumulating
  }, 300000);

  // Graceful shutdown
  const shutdown = (): void => {
    log.info('Shutting down...');
    clearInterval(cleanupInterval);
    clearInterval(metricsInterval);

    // Final metrics flush before shutdown
    log.info('Flushing final metrics');
    metrics.flush(false);

    pipeline.stop();
    wsHandler.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Start HTTP server
  app.listen(config.port, () => {
    log.info(
      { port: config.port, wsPort: config.wsPort },
      'Jarvis orchestrator started'
    );
  });
}

main().catch((error) => {
  logger.error({ error }, 'Failed to start orchestrator');
  process.exit(1);
});
