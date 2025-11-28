import { SessionManager } from './session-manager';

describe('SessionManager', () => {
  let sessionManager: SessionManager;

  beforeEach(() => {
    sessionManager = new SessionManager();
  });

  describe('createSession()', () => {
    it('should create a new session with unique IDs', () => {
      const session1 = sessionManager.createSession('user-1');
      const session2 = sessionManager.createSession('user-1');

      expect(session1.id).toBeDefined();
      expect(session2.id).toBeDefined();
      expect(session1.id).not.toBe(session2.id);
      expect(session1.conversationId).not.toBe(session2.conversationId);
    });

    it('should initialize session in idle state', () => {
      const session = sessionManager.createSession('user-1');

      expect(session.state).toBe('idle');
    });

    it('should set timestamps on creation', () => {
      const beforeCreate = new Date();
      const session = sessionManager.createSession('user-1');
      const afterCreate = new Date();

      expect(session.startedAt.getTime()).toBeGreaterThanOrEqual(beforeCreate.getTime());
      expect(session.startedAt.getTime()).toBeLessThanOrEqual(afterCreate.getTime());
      expect(session.lastActivityAt.getTime()).toBeGreaterThanOrEqual(beforeCreate.getTime());
      expect(session.lastActivityAt.getTime()).toBeLessThanOrEqual(afterCreate.getTime());
    });

    it('should create associated conversation', () => {
      const session = sessionManager.createSession('user-123');
      const conversation = sessionManager.getConversation(session.conversationId);

      expect(conversation).toBeDefined();
      expect(conversation?.userId).toBe('user-123');
      expect(conversation?.messages).toEqual([]);
      expect(conversation?.id).toBe(session.conversationId);
    });

    it('should handle multiple users', () => {
      const session1 = sessionManager.createSession('user-1');
      const session2 = sessionManager.createSession('user-2');
      const session3 = sessionManager.createSession('user-3');

      const conv1 = sessionManager.getConversation(session1.conversationId);
      const conv2 = sessionManager.getConversation(session2.conversationId);
      const conv3 = sessionManager.getConversation(session3.conversationId);

      expect(conv1?.userId).toBe('user-1');
      expect(conv2?.userId).toBe('user-2');
      expect(conv3?.userId).toBe('user-3');
    });
  });

  describe('getSession()', () => {
    it('should retrieve existing session by ID', () => {
      const created = sessionManager.createSession('user-1');
      const retrieved = sessionManager.getSession(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(created.id);
      expect(retrieved?.conversationId).toBe(created.conversationId);
    });

    it('should return undefined for non-existent session', () => {
      const session = sessionManager.getSession('non-existent-id');
      expect(session).toBeUndefined();
    });

    it('should return the same object reference', () => {
      const created = sessionManager.createSession('user-1');
      const retrieved1 = sessionManager.getSession(created.id);
      const retrieved2 = sessionManager.getSession(created.id);

      expect(retrieved1).toBe(retrieved2);
    });
  });

  describe('getConversation()', () => {
    it('should retrieve existing conversation by ID', () => {
      const session = sessionManager.createSession('user-1');
      const conversation = sessionManager.getConversation(session.conversationId);

      expect(conversation).toBeDefined();
      expect(conversation?.id).toBe(session.conversationId);
    });

    it('should return undefined for non-existent conversation', () => {
      const conversation = sessionManager.getConversation('non-existent-id');
      expect(conversation).toBeUndefined();
    });
  });

  describe('updateSessionState()', () => {
    it('should update session state', () => {
      const session = sessionManager.createSession('user-1');
      expect(session.state).toBe('idle');

      sessionManager.updateSessionState(session.id, 'listening');
      const updated = sessionManager.getSession(session.id);
      expect(updated?.state).toBe('listening');
    });

    it('should update lastActivityAt timestamp', async () => {
      const session = sessionManager.createSession('user-1');
      const initialTime = session.lastActivityAt.getTime();

      // Wait a bit to ensure timestamp changes
      await new Promise((resolve) => setTimeout(resolve, 10));

      sessionManager.updateSessionState(session.id, 'processing');
      const updated = sessionManager.getSession(session.id);
      expect(updated?.lastActivityAt.getTime()).toBeGreaterThan(initialTime);
    });

    it('should handle all valid session states', () => {
      const session = sessionManager.createSession('user-1');

      const states: Array<'idle' | 'listening' | 'processing' | 'speaking' | 'interrupted'> = [
        'idle',
        'listening',
        'processing',
        'speaking',
        'interrupted',
      ];

      for (const state of states) {
        sessionManager.updateSessionState(session.id, state);
        const updated = sessionManager.getSession(session.id);
        expect(updated?.state).toBe(state);
      }
    });

    it('should handle updates to non-existent session gracefully', () => {
      expect(() => {
        sessionManager.updateSessionState('non-existent-id', 'listening');
      }).not.toThrow();
    });

    it('should preserve other session properties', () => {
      const session = sessionManager.createSession('user-1');
      const originalId = session.id;
      const originalConversationId = session.conversationId;
      const originalStartedAt = session.startedAt;

      sessionManager.updateSessionState(session.id, 'speaking');
      const updated = sessionManager.getSession(session.id);

      expect(updated?.id).toBe(originalId);
      expect(updated?.conversationId).toBe(originalConversationId);
      expect(updated?.startedAt).toEqual(originalStartedAt);
    });
  });

  describe('interrupt()', () => {
    it('should interrupt a processing session', () => {
      const session = sessionManager.createSession('user-1');
      sessionManager.updateSessionState(session.id, 'processing');

      const result = sessionManager.interrupt(session.id);
      expect(result).toBe(true);

      const updated = sessionManager.getSession(session.id);
      expect(updated?.state).toBe('interrupted');
    });

    it('should interrupt a speaking session', () => {
      const session = sessionManager.createSession('user-1');
      sessionManager.updateSessionState(session.id, 'speaking');

      const result = sessionManager.interrupt(session.id);
      expect(result).toBe(true);

      const updated = sessionManager.getSession(session.id);
      expect(updated?.state).toBe('interrupted');
    });

    it('should not interrupt an idle session', () => {
      const session = sessionManager.createSession('user-1');
      const result = sessionManager.interrupt(session.id);

      expect(result).toBe(false);
      expect(session.state).toBe('idle');
    });

    it('should not interrupt a listening session', () => {
      const session = sessionManager.createSession('user-1');
      sessionManager.updateSessionState(session.id, 'listening');

      const result = sessionManager.interrupt(session.id);
      expect(result).toBe(false);

      const updated = sessionManager.getSession(session.id);
      expect(updated?.state).toBe('listening');
    });

    it('should not interrupt an already interrupted session', () => {
      const session = sessionManager.createSession('user-1');
      sessionManager.updateSessionState(session.id, 'interrupted');

      const result = sessionManager.interrupt(session.id);
      expect(result).toBe(false);
    });

    it('should return false for non-existent session', () => {
      const result = sessionManager.interrupt('non-existent-id');
      expect(result).toBe(false);
    });
  });

  describe('endSession()', () => {
    it('should remove session from manager', () => {
      const session = sessionManager.createSession('user-1');
      expect(sessionManager.getSession(session.id)).toBeDefined();

      sessionManager.endSession(session.id);
      expect(sessionManager.getSession(session.id)).toBeUndefined();
    });

    it('should handle ending non-existent session gracefully', () => {
      expect(() => {
        sessionManager.endSession('non-existent-id');
      }).not.toThrow();
    });

    it('should not affect other sessions', () => {
      const session1 = sessionManager.createSession('user-1');
      const session2 = sessionManager.createSession('user-2');
      const session3 = sessionManager.createSession('user-3');

      sessionManager.endSession(session2.id);

      expect(sessionManager.getSession(session1.id)).toBeDefined();
      expect(sessionManager.getSession(session2.id)).toBeUndefined();
      expect(sessionManager.getSession(session3.id)).toBeDefined();
    });

    it('should allow ending session multiple times', () => {
      const session = sessionManager.createSession('user-1');

      expect(() => {
        sessionManager.endSession(session.id);
        sessionManager.endSession(session.id);
        sessionManager.endSession(session.id);
      }).not.toThrow();
    });
  });

  describe('cleanupStaleSessions()', () => {
    it('should remove sessions that exceed timeout', () => {
      const session1 = sessionManager.createSession('user-1');
      const session2 = sessionManager.createSession('user-2');

      // Manually modify lastActivityAt to simulate old sessions
      const oldSession = sessionManager.getSession(session1.id);
      if (oldSession) {
        oldSession.lastActivityAt = new Date(Date.now() - 10000); // 10 seconds ago
      }

      const cleaned = sessionManager.cleanupStaleSessions(5000); // 5 second timeout

      expect(cleaned).toBe(1);
      expect(sessionManager.getSession(session1.id)).toBeUndefined();
      expect(sessionManager.getSession(session2.id)).toBeDefined();
    });

    it('should not remove sessions within timeout', () => {
      const session1 = sessionManager.createSession('user-1');
      const session2 = sessionManager.createSession('user-2');

      const cleaned = sessionManager.cleanupStaleSessions(60000); // 1 minute timeout

      expect(cleaned).toBe(0);
      expect(sessionManager.getSession(session1.id)).toBeDefined();
      expect(sessionManager.getSession(session2.id)).toBeDefined();
    });

    it('should return correct count of cleaned sessions', () => {
      const sessions = [
        sessionManager.createSession('user-1'),
        sessionManager.createSession('user-2'),
        sessionManager.createSession('user-3'),
        sessionManager.createSession('user-4'),
      ];

      // Make first 3 sessions stale
      for (let i = 0; i < 3; i++) {
        const session = sessionManager.getSession(sessions[i].id);
        if (session) {
          session.lastActivityAt = new Date(Date.now() - 10000);
        }
      }

      const cleaned = sessionManager.cleanupStaleSessions(5000);

      expect(cleaned).toBe(3);
      expect(sessionManager.getSession(sessions[3].id)).toBeDefined();
    });

    it('should return 0 when no sessions are stale', () => {
      sessionManager.createSession('user-1');
      sessionManager.createSession('user-2');

      const cleaned = sessionManager.cleanupStaleSessions(60000);
      expect(cleaned).toBe(0);
    });

    it('should handle empty session manager', () => {
      const cleaned = sessionManager.cleanupStaleSessions(5000);
      expect(cleaned).toBe(0);
    });

    it('should update session activity on state changes', async () => {
      const session = sessionManager.createSession('user-1');

      // Simulate time passing
      const modifiedSession = sessionManager.getSession(session.id);
      if (modifiedSession) {
        modifiedSession.lastActivityAt = new Date(Date.now() - 10000);
      }

      const oldTime = modifiedSession!.lastActivityAt.getTime();

      // Wait a bit to ensure timestamp changes
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Update state should refresh activity timestamp
      sessionManager.updateSessionState(session.id, 'listening');
      const updated = sessionManager.getSession(session.id);

      expect(updated?.lastActivityAt.getTime()).toBeGreaterThan(oldTime);
    });
  });

  describe('Integration Scenarios', () => {
    it('should handle complete session lifecycle', () => {
      // Create session
      const session = sessionManager.createSession('user-1');
      expect(session.state).toBe('idle');

      // Progress through states
      sessionManager.updateSessionState(session.id, 'listening');
      expect(sessionManager.getSession(session.id)?.state).toBe('listening');

      sessionManager.updateSessionState(session.id, 'processing');
      expect(sessionManager.getSession(session.id)?.state).toBe('processing');

      sessionManager.updateSessionState(session.id, 'speaking');
      expect(sessionManager.getSession(session.id)?.state).toBe('speaking');

      // Interrupt
      const interrupted = sessionManager.interrupt(session.id);
      expect(interrupted).toBe(true);
      expect(sessionManager.getSession(session.id)?.state).toBe('interrupted');

      // End session
      sessionManager.endSession(session.id);
      expect(sessionManager.getSession(session.id)).toBeUndefined();
    });

    it('should handle concurrent sessions correctly', () => {
      const session1 = sessionManager.createSession('user-1');
      const session2 = sessionManager.createSession('user-2');
      const session3 = sessionManager.createSession('user-3');

      sessionManager.updateSessionState(session1.id, 'listening');
      sessionManager.updateSessionState(session2.id, 'processing');
      sessionManager.updateSessionState(session3.id, 'speaking');

      expect(sessionManager.getSession(session1.id)?.state).toBe('listening');
      expect(sessionManager.getSession(session2.id)?.state).toBe('processing');
      expect(sessionManager.getSession(session3.id)?.state).toBe('speaking');

      sessionManager.interrupt(session2.id);
      sessionManager.interrupt(session3.id);

      expect(sessionManager.getSession(session1.id)?.state).toBe('listening');
      expect(sessionManager.getSession(session2.id)?.state).toBe('interrupted');
      expect(sessionManager.getSession(session3.id)?.state).toBe('interrupted');
    });

    it('should maintain conversation consistency', () => {
      const session = sessionManager.createSession('user-1');
      const conversationId = session.conversationId;

      // Verify conversation exists
      const conversation = sessionManager.getConversation(conversationId);
      expect(conversation).toBeDefined();
      expect(conversation?.id).toBe(conversationId);

      // End session
      sessionManager.endSession(session.id);

      // Conversation should still exist even after session ends
      const stillExists = sessionManager.getConversation(conversationId);
      expect(stillExists).toBeDefined();
    });
  });
});
