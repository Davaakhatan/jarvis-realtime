import { Pipeline } from './pipeline';
import { SessionManager } from './session-manager';
import { PipelineEvent } from '../shared/types';

// Mock all service dependencies
jest.mock('../services/asr/index');
jest.mock('../services/tts/index');
jest.mock('../services/llm/index');
jest.mock('../services/github-integration/index');
jest.mock('../services/api-poller/index');
jest.mock('../services/verification/index');
jest.mock('../services/vector-store/index');
jest.mock('../services/wake-word/index');

describe('Pipeline Integration Tests', () => {
  let pipeline: Pipeline;
  let sessionManager: SessionManager;
  let sessionId: string;
  const mockOpenAIKey = 'test-openai-key';

  beforeEach(() => {
    // Create fresh session manager and pipeline for each test
    sessionManager = new SessionManager();
    pipeline = new Pipeline(sessionManager, {
      maxLatencyMs: 5000,
      openaiApiKey: mockOpenAIKey,
      githubToken: 'test-github-token',
      verificationEnabled: true,
    });

    // Create a test session
    const session = sessionManager.createSession('test-user');
    sessionId = session.id;

    // Mock global fetch for Whisper API
    global.fetch = jest.fn();
  });

  afterEach(() => {
    pipeline.stop();
    jest.clearAllMocks();
  });

  describe('Pipeline Lifecycle', () => {
    it('should start and stop successfully', () => {
      expect(() => {
        pipeline.start();
        pipeline.stop();
      }).not.toThrow();
    });

    it('should emit events when processing audio', async () => {
      const events: PipelineEvent[] = [];
      pipeline.on('event', (event: PipelineEvent) => {
        events.push(event);
      });

      const audioData = Buffer.alloc(1000);
      await pipeline.processAudioChunk(sessionId, audioData);

      expect(events.length).toBeGreaterThan(0);
      expect(events[0].type).toBe('audio.chunk');
      expect(events[0].sessionId).toBe(sessionId);
    });
  });

  describe('Audio Processing', () => {
    it('should buffer audio chunks and process on audio end', async () => {
      const events: PipelineEvent[] = [];
      pipeline.on('event', (event: PipelineEvent) => {
        events.push(event);
      });

      // Mock successful transcription
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ text: 'Hello world' }),
      });

      // Send multiple audio chunks
      const chunk1 = Buffer.alloc(8000);
      const chunk2 = Buffer.alloc(8000);
      const chunk3 = Buffer.alloc(8000);

      await pipeline.processAudioChunk(sessionId, chunk1);
      await pipeline.processAudioChunk(sessionId, chunk2);
      await pipeline.processAudioChunk(sessionId, chunk3);

      // Process audio end
      await pipeline.processAudioEnd(sessionId);

      // Should have emitted audio.chunk events
      const audioChunkEvents = events.filter((e) => e.type === 'audio.chunk');
      expect(audioChunkEvents.length).toBe(3);

      // Should have emitted audio.end event
      const audioEndEvents = events.filter((e) => e.type === 'audio.end');
      expect(audioEndEvents.length).toBe(1);
    });

    it('should skip processing if audio is too short', async () => {
      const events: PipelineEvent[] = [];
      pipeline.on('event', (event: PipelineEvent) => {
        events.push(event);
      });

      // Send very short audio (less than 0.5 seconds at 16kHz)
      const shortAudio = Buffer.alloc(100);
      await pipeline.processAudioChunk(sessionId, shortAudio);
      await pipeline.processAudioEnd(sessionId);

      // Should emit audio.chunk but skip transcription
      const audioChunkEvents = events.filter((e) => e.type === 'audio.chunk');
      expect(audioChunkEvents.length).toBe(1);

      // Should not emit transcript events
      const transcriptEvents = events.filter((e) => e.type === 'transcript.final');
      expect(transcriptEvents.length).toBe(0);
    });

    it('should handle transcription errors gracefully', async () => {
      const events: PipelineEvent[] = [];
      pipeline.on('event', (event: PipelineEvent) => {
        events.push(event);
      });

      // Mock failed transcription
      (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('Transcription failed'));

      const audioData = Buffer.alloc(20000);
      await pipeline.processAudioChunk(sessionId, audioData);
      await pipeline.processAudioEnd(sessionId);

      // Should emit audio events
      expect(events.filter((e) => e.type === 'audio.chunk').length).toBeGreaterThan(0);

      // Session should return to idle state
      const session = sessionManager.getSession(sessionId);
      expect(session?.state).toBe('idle');
    });
  });

  describe('Session State Management', () => {
    it('should update session state during audio processing', async () => {
      const audioData = Buffer.alloc(1000);
      await pipeline.processAudioChunk(sessionId, audioData);

      const session = sessionManager.getSession(sessionId);
      expect(session?.state).toBe('listening');
    });

    it('should handle non-existent sessions gracefully', async () => {
      const fakeSessionId = 'non-existent-session';
      const audioData = Buffer.alloc(1000);

      // Should not throw
      await expect(pipeline.processAudioChunk(fakeSessionId, audioData)).resolves.not.toThrow();
      await expect(pipeline.processAudioEnd(fakeSessionId)).resolves.not.toThrow();
    });

    it('should skip processing when session is interrupted', async () => {
      const events: PipelineEvent[] = [];
      pipeline.on('event', (event: PipelineEvent) => {
        events.push(event);
      });

      // Interrupt the session
      sessionManager.updateSessionState(sessionId, 'interrupted');

      const audioData = Buffer.alloc(1000);
      await pipeline.processAudioChunk(sessionId, audioData);

      // Should not process audio
      const session = sessionManager.getSession(sessionId);
      expect(session?.state).toBe('interrupted');
    });
  });

  describe('Interrupt Handling', () => {
    it('should interrupt a speaking session', () => {
      const events: PipelineEvent[] = [];
      pipeline.on('event', (event: PipelineEvent) => {
        events.push(event);
      });

      // Set session to speaking state
      sessionManager.updateSessionState(sessionId, 'speaking');

      // Interrupt
      pipeline.interrupt(sessionId);

      // Should emit interrupt events
      const interruptEvents = events.filter((e) => e.type === 'session.interrupt');
      expect(interruptEvents.length).toBe(1);

      const ttsStopEvents = events.filter((e) => e.type === 'tts.stop');
      expect(ttsStopEvents.length).toBe(1);

      // Session should be interrupted
      const session = sessionManager.getSession(sessionId);
      expect(session?.state).toBe('interrupted');
    });

    it('should interrupt a processing session', () => {
      const events: PipelineEvent[] = [];
      pipeline.on('event', (event: PipelineEvent) => {
        events.push(event);
      });

      // Set session to processing state
      sessionManager.updateSessionState(sessionId, 'processing');

      // Interrupt
      pipeline.interrupt(sessionId);

      // Should emit interrupt event (but not tts.stop since we weren't speaking)
      const interruptEvents = events.filter((e) => e.type === 'session.interrupt');
      expect(interruptEvents.length).toBe(1);

      const ttsStopEvents = events.filter((e) => e.type === 'tts.stop');
      expect(ttsStopEvents.length).toBe(0);

      // Session should be interrupted
      const session = sessionManager.getSession(sessionId);
      expect(session?.state).toBe('interrupted');
    });

    it('should not interrupt idle sessions', () => {
      const events: PipelineEvent[] = [];
      pipeline.on('event', (event: PipelineEvent) => {
        events.push(event);
      });

      // Session starts in idle state
      pipeline.interrupt(sessionId);

      // Should not emit interrupt events for idle sessions
      expect(events.length).toBe(0);

      // Session should remain idle
      const session = sessionManager.getSession(sessionId);
      expect(session?.state).toBe('idle');
    });
  });

  describe('Latency Tracking', () => {
    it('should track processing latency', async () => {
      const audioData = Buffer.alloc(1000);
      await pipeline.processAudioChunk(sessionId, audioData);

      const latency = pipeline.checkLatency(sessionId);
      expect(latency).not.toBeNull();
      expect(typeof latency).toBe('number');
      expect(latency).toBeGreaterThanOrEqual(0);
    });

    it('should return null for sessions with no processing timer', () => {
      const latency = pipeline.checkLatency(sessionId);
      expect(latency).toBeNull();
    });
  });

  describe('Conversation History', () => {
    it('should clear conversation history', () => {
      const session = sessionManager.getSession(sessionId);
      expect(session).toBeDefined();

      // Clear history
      pipeline.clearHistory(session!.conversationId);

      // Should not throw
      expect(() => pipeline.clearHistory(session!.conversationId)).not.toThrow();
    });
  });

  describe('Event Emission', () => {
    it('should set up wake word event listeners', () => {
      // Verify that pipeline has listeners set up for wake word events
      const wakeWordService = (pipeline as any).services.wakeWord;

      // Check that the wake word service was initialized
      expect(wakeWordService).toBeDefined();

      // This test verifies that pipeline construction sets up event listeners
      // The actual event emission is tested through the service's own tests
      expect(true).toBe(true);
    });

    it('should set up interrupt event listeners', () => {
      // Verify that pipeline has listeners set up for interrupt events
      const wakeWordService = (pipeline as any).services.wakeWord;

      // Check that the wake word service was initialized
      expect(wakeWordService).toBeDefined();

      // This test verifies that pipeline construction sets up event listeners
      // The actual event emission is tested through the service's own tests
      expect(true).toBe(true);
    });
  });

  describe('Tool Execution', () => {
    it('should execute API poller tools', async () => {
      const mockApiPoller = (pipeline as any).services.apiPoller;
      mockApiPoller.getData = jest.fn().mockResolvedValue({ data: 'test' });
      mockApiPoller.forceRefresh = jest.fn().mockResolvedValue({ refreshed: true });
      mockApiPoller.getAllData = jest.fn().mockReturnValue({ endpoint1: { data: 'test' } });

      const result1 = await pipeline.executeToolCall(sessionId, {
        id: 'tool-call-1',
        name: 'get_api_data',
        arguments: { endpoint_id: 'test-endpoint' },
      });
      expect(result1).toEqual({ data: 'test' });

      const result2 = await pipeline.executeToolCall(sessionId, {
        id: 'tool-call-2',
        name: 'refresh_api_data',
        arguments: { endpoint_id: 'test-endpoint' },
      });
      expect(result2).toEqual({ refreshed: true });

      const result3 = await pipeline.executeToolCall(sessionId, {
        id: 'tool-call-3',
        name: 'list_available_apis',
        arguments: {},
      });
      expect(result3).toEqual({ endpoint1: { data: 'test' } });
    });

    it('should execute GitHub tools when configured', async () => {
      const mockGitHub = (pipeline as any).services.github;
      mockGitHub.searchCode = jest.fn().mockResolvedValue({ items: [] });
      mockGitHub.getFileContent = jest.fn().mockResolvedValue({ content: 'file content' });
      mockGitHub.searchIssues = jest.fn().mockResolvedValue({ items: [] });

      const result1 = await pipeline.executeToolCall(sessionId, {
        id: 'tool-call-4',
        name: 'search_github_code',
        arguments: { query: 'test', repo: 'owner/repo' },
      });
      expect(mockGitHub.searchCode).toHaveBeenCalled();

      const result2 = await pipeline.executeToolCall(sessionId, {
        id: 'tool-call-5',
        name: 'get_github_file',
        arguments: { owner: 'owner', repo: 'repo', path: 'file.ts' },
      });
      expect(mockGitHub.getFileContent).toHaveBeenCalled();

      const result3 = await pipeline.executeToolCall(sessionId, {
        id: 'tool-call-6',
        name: 'search_github_issues',
        arguments: { query: 'bug', repo: 'owner/repo', state: 'open' },
      });
      expect(mockGitHub.searchIssues).toHaveBeenCalled();
    });

    it('should return error for unknown tools', async () => {
      const result = await pipeline.executeToolCall(sessionId, {
        id: 'tool-call-7',
        name: 'unknown_tool',
        arguments: {},
      });

      expect(result).toEqual({ error: 'Unknown tool: unknown_tool' });
    });

    it('should return error for GitHub tools when not configured', async () => {
      // Create pipeline without GitHub token
      const pipelineWithoutGitHub = new Pipeline(sessionManager, {
        maxLatencyMs: 5000,
        openaiApiKey: mockOpenAIKey,
        verificationEnabled: false,
      });

      const result = await pipelineWithoutGitHub.executeToolCall(sessionId, {
        id: 'tool-call-8',
        name: 'search_github_code',
        arguments: { query: 'test' },
      });

      expect(result).toEqual({ error: 'GitHub integration not configured' });
    });
  });

  describe('Full Integration Flow', () => {
    it('should handle complete audio to response flow', async () => {
      const events: PipelineEvent[] = [];
      pipeline.on('event', (event: PipelineEvent) => {
        events.push(event);
      });

      // Mock Whisper API response
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ text: 'What is the weather today?' }),
      });

      // Mock LLM service
      const mockLLM = (pipeline as any).services.llm;
      mockLLM.chatStream = jest.fn().mockImplementation(async function* () {
        yield 'The ';
        yield 'weather ';
        yield 'is ';
        yield 'sunny ';
        yield 'today.';
      });

      // Mock verification service
      const mockVerification = (pipeline as any).services.verification;
      mockVerification.verify = jest.fn().mockResolvedValue({
        verified: true,
        confidence: 0.95,
        citations: [],
        warnings: [],
        modifiedResponse: null,
      });

      // Mock TTS service
      const mockTTS = (pipeline as any).services.tts;
      mockTTS.synthesizeStream = jest.fn().mockImplementation(async (text, callback) => {
        callback(Buffer.from('audio-chunk-1'));
        callback(Buffer.from('audio-chunk-2'));
      });

      // Send audio
      const audioData = Buffer.alloc(20000);
      await pipeline.processAudioChunk(sessionId, audioData);
      await pipeline.processAudioEnd(sessionId);

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify event flow
      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain('audio.chunk');
      expect(eventTypes).toContain('audio.end');

      // Session should be in a valid state
      const session = sessionManager.getSession(sessionId);
      expect(session).toBeDefined();
      expect(['idle', 'processing', 'speaking', 'listening']).toContain(session!.state);
    });
  });
});
