import express from 'express';
import { config, logger, createChildLogger } from '../shared/utils/index.js';
import { SessionManager } from './session-manager.js';
import { Pipeline } from './pipeline.js';
import { WebSocketHandler } from './websocket-handler.js';

const log = createChildLogger('main');

async function main(): Promise<void> {
  log.info('Starting Jarvis orchestrator...');

  // Initialize components
  const sessionManager = new SessionManager();
  const pipeline = new Pipeline(sessionManager, {
    maxLatencyMs: config.maxLatencyMs,
  });

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
    // TODO: Add actual readiness checks (Redis, ASR, TTS connections)
    res.json({ ready: true });
  });

  // Session cleanup interval
  const cleanupInterval = setInterval(() => {
    sessionManager.cleanupStaleSessions(config.sessionTimeoutMs);
  }, 60000);

  // Graceful shutdown
  const shutdown = (): void => {
    log.info('Shutting down...');
    clearInterval(cleanupInterval);
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
