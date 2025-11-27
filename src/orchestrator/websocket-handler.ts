import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import { v4 as uuidv4 } from 'uuid';
import {
  createChildLogger,
  withCorrelationId,
  generateCorrelationId,
} from '../shared/utils/index';
import { SessionManager } from './session-manager';
import { Pipeline } from './pipeline';

const logger = createChildLogger('websocket');

interface ClientConnection {
  ws: WebSocket;
  sessionId: string;
  userId: string;
  correlationId: string;
}

export class WebSocketHandler {
  private wss: WebSocketServer;
  private sessionManager: SessionManager;
  private pipeline: Pipeline;
  private connections: Map<string, ClientConnection> = new Map();

  constructor(
    port: number,
    sessionManager: SessionManager,
    pipeline: Pipeline
  ) {
    this.sessionManager = sessionManager;
    this.pipeline = pipeline;

    this.wss = new WebSocketServer({ port });
    this.setupEventHandlers();

    logger.info({ port }, 'WebSocket server started');
  }

  private setupEventHandlers(): void {
    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      this.handleConnection(ws, req);
    });

    this.pipeline.on('event', (event) => {
      this.broadcastToSession(event.sessionId, event);
    });
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    // Extract userId from query params or headers
    const userId = this.extractUserId(req) || uuidv4();
    const correlationId = generateCorrelationId();
    const session = this.sessionManager.createSession(userId);

    const connection: ClientConnection = {
      ws,
      sessionId: session.id,
      userId,
      correlationId,
    };

    this.connections.set(session.id, connection);

    // Log with correlation ID
    withCorrelationId(correlationId, () => {
      logger.info({ sessionId: session.id, userId }, 'Client connected');
    });

    ws.on('message', (data: Buffer) => {
      // Wrap message handling with correlation ID context
      withCorrelationId(correlationId, () => {
        this.handleMessage(session.id, data);
      });
    });

    ws.on('close', () => {
      withCorrelationId(correlationId, () => {
        this.handleDisconnect(session.id);
      });
    });

    ws.on('error', (error) => {
      withCorrelationId(correlationId, () => {
        logger.error({ sessionId: session.id, error }, 'WebSocket error');
      });
    });

    // Send session info to client
    this.send(ws, {
      type: 'session.created',
      sessionId: session.id,
      conversationId: session.conversationId,
      correlationId,
    });
  }

  private handleMessage(sessionId: string, data: Buffer): void {
    try {
      // Check if it's binary audio data or JSON message
      if (this.isBinaryAudio(data)) {
        this.pipeline.processAudioChunk(sessionId, data);
      } else {
        const message = JSON.parse(data.toString());
        this.handleJsonMessage(sessionId, message);
      }
    } catch (error) {
      logger.error({ sessionId, error }, 'Error handling message');
    }
  }

  private handleJsonMessage(
    sessionId: string,
    message: { type: string; [key: string]: unknown }
  ): void {
    switch (message.type) {
      case 'interrupt':
        this.pipeline.interrupt(sessionId);
        break;
      case 'audio.end':
        // Audio recording stopped, trigger processing
        logger.debug({ sessionId }, 'Audio stream ended');
        this.pipeline.processAudioEnd(sessionId);
        break;
      case 'transcript':
        if (typeof message.text === 'string') {
          this.pipeline.processTranscript(
            sessionId,
            message.text,
            message.isFinal === true
          );
        }
        break;
      default:
        logger.warn({ sessionId, type: message.type }, 'Unknown message type');
    }
  }

  private handleDisconnect(sessionId: string): void {
    this.sessionManager.endSession(sessionId);
    this.connections.delete(sessionId);
    logger.info({ sessionId }, 'Client disconnected');
  }

  private broadcastToSession(sessionId: string, data: unknown): void {
    const connection = this.connections.get(sessionId);
    if (connection && connection.ws.readyState === WebSocket.OPEN) {
      this.send(connection.ws, data);
    }
  }

  private send(ws: WebSocket, data: unknown): void {
    ws.send(JSON.stringify(data));
  }

  private extractUserId(req: IncomingMessage): string | null {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    return url.searchParams.get('userId');
  }

  private isBinaryAudio(data: Buffer): boolean {
    // Simple heuristic: if it doesn't start with '{', assume it's binary audio
    return data[0] !== 0x7b;
  }

  close(): void {
    this.wss.close();
    logger.info('WebSocket server closed');
  }
}
