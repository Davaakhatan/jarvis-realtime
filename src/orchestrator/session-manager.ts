import { v4 as uuidv4 } from 'uuid';
import { Session, SessionState, Conversation } from '../shared/types/index';
import { createChildLogger } from '../shared/utils/index';

const logger = createChildLogger('session-manager');

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private conversations: Map<string, Conversation> = new Map();

  createSession(userId: string): Session {
    const conversationId = uuidv4();
    const sessionId = uuidv4();
    const now = new Date();

    const conversation: Conversation = {
      id: conversationId,
      userId,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };

    const session: Session = {
      id: sessionId,
      conversationId,
      state: 'idle',
      startedAt: now,
      lastActivityAt: now,
    };

    this.conversations.set(conversationId, conversation);
    this.sessions.set(sessionId, session);

    logger.info({ sessionId, userId }, 'Session created');
    return session;
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  getConversation(conversationId: string): Conversation | undefined {
    return this.conversations.get(conversationId);
  }

  updateSessionState(sessionId: string, newState: SessionState): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      logger.warn({ sessionId }, 'Session not found for state update');
      return;
    }

    const previousState = session.state;
    session.state = newState;
    session.lastActivityAt = new Date();

    logger.debug({ sessionId, previousState, newState }, 'Session state updated');
  }

  interrupt(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    if (session.state === 'processing' || session.state === 'speaking') {
      this.updateSessionState(sessionId, 'interrupted');
      logger.info({ sessionId }, 'Session interrupted');
      return true;
    }

    return false;
  }

  endSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.sessions.delete(sessionId);
      logger.info({ sessionId }, 'Session ended');
    }
  }

  cleanupStaleSessions(timeoutMs: number): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [sessionId, session] of this.sessions) {
      if (now - session.lastActivityAt.getTime() > timeoutMs) {
        this.endSession(sessionId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.info({ cleaned }, 'Cleaned up stale sessions');
    }

    return cleaned;
  }
}
