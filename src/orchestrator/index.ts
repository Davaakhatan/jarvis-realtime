import express from 'express';
import { config, logger, createChildLogger } from '../shared/utils/index';
import { SessionManager } from './session-manager';
import { Pipeline } from './pipeline';
import { WebSocketHandler } from './websocket-handler';

const log = createChildLogger('main');

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

  // Setup REST API for health checks and management
  const app = express();
  app.use(express.json());

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.get('/ready', (req, res) => {
    res.json({ ready: true });
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

  // Graceful shutdown
  const shutdown = (): void => {
    log.info('Shutting down...');
    clearInterval(cleanupInterval);
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
