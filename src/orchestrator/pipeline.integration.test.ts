import { Pipeline, PipelineOptions } from './pipeline';
import { SessionManager } from './session-manager';
import { ASRService } from '../services/asr';
import { TTSService } from '../services/tts';
import { LLMService } from '../services/llm';
import { VerificationClient } from '../services/verification';

// Mock all the services
jest.mock('../services/asr');
jest.mock('../services/tts');
jest.mock('../services/llm');
jest.mock('../services/github-integration');
jest.mock('../services/api-poller');
jest.mock('../services/verification');
jest.mock('../services/vector-store');
jest.mock('../services/wake-word');

describe('Pipeline Integration Tests', () => {
  let pipeline: Pipeline;
  let sessionManager: SessionManager;
  const mockOptions: PipelineOptions = {
    maxLatencyMs: 500,
    openaiApiKey: 'test-api-key',
    githubToken: 'test-github-token',
    verificationEnabled: true,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    sessionManager = new SessionManager();
    pipeline = new Pipeline(sessionManager, mockOptions);
  });

  afterEach(() => {
    if (pipeline) {
      pipeline.cleanup();
    }
  });

  describe('Pipeline Initialization', () => {
    it('should initialize all services correctly', () => {
      expect(ASRService).toHaveBeenCalledWith({
        apiKey: mockOptions.openaiApiKey,
      });

      expect(TTSService).toHaveBeenCalledWith({
        apiKey: mockOptions.openaiApiKey,
        voice: 'nova',
      });

      expect(LLMService).toHaveBeenCalledWith({
        apiKey: mockOptions.openaiApiKey,
        model: 'gpt-4-turbo-preview',
      });

      expect(VerificationClient).toHaveBeenCalled();
    });

    it('should create session manager instance', () => {
      expect(sessionManager).toBeInstanceOf(SessionManager);
    });
  });

  describe('Audio Processing Flow', () => {
    const mockSessionId = 'test-session-123';
    const mockAudioChunk = Buffer.from('mock-audio-data');

    beforeEach(() => {
      sessionManager.createSession(mockSessionId);
    });

    it('should process audio chunk through ASR service', async () => {
      const mockTranscript = {
        text: 'Hello, how are you?',
        isFinal: true,
        confidence: 0.95,
      };

      (ASRService as jest.Mock).mockImplementation(() => ({
        processAudioChunk: jest.fn().mockResolvedValue(mockTranscript),
      }));

      pipeline = new Pipeline(sessionManager, mockOptions);

      const result = await pipeline.processAudioChunk(
        mockSessionId,
        mockAudioChunk
      );

      expect(result).toBeDefined();
    });

    it('should buffer audio chunks before final transcript', async () => {
      const chunk1 = Buffer.from('chunk1');
      const chunk2 = Buffer.from('chunk2');
      const chunk3 = Buffer.from('chunk3');

      const mockASR = {
        processAudioChunk: jest
          .fn()
          .mockResolvedValueOnce({ text: 'Hello', isFinal: false, confidence: 0.8 })
          .mockResolvedValueOnce({ text: 'Hello world', isFinal: false, confidence: 0.9 })
          .mockResolvedValueOnce({ text: 'Hello world!', isFinal: true, confidence: 0.95 }),
      };

      (ASRService as jest.Mock).mockImplementation(() => mockASR);
      pipeline = new Pipeline(sessionManager, mockOptions);

      await pipeline.processAudioChunk(mockSessionId, chunk1);
      await pipeline.processAudioChunk(mockSessionId, chunk2);
      const finalResult = await pipeline.processAudioChunk(mockSessionId, chunk3);

      expect(mockASR.processAudioChunk).toHaveBeenCalledTimes(3);
      expect(finalResult).toBeDefined();
    });
  });

  describe('LLM Processing Flow', () => {
    const mockSessionId = 'test-session-456';

    beforeEach(() => {
      sessionManager.createSession(mockSessionId);
    });

    it('should process user message through LLM', async () => {
      const mockResponse = {
        text: 'I am doing well, thank you!',
        toolCalls: [],
      };

      const mockLLM = {
        generateResponse: jest.fn().mockResolvedValue(mockResponse),
        registerTool: jest.fn(),
      };

      (LLMService as jest.Mock).mockImplementation(() => mockLLM);
      pipeline = new Pipeline(sessionManager, mockOptions);

      const userMessage = 'How are you?';
      await pipeline.processUserMessage(mockSessionId, userMessage);

      expect(mockLLM.generateResponse).toHaveBeenCalled();
    });

    it('should handle LLM tool calls', async () => {
      const mockToolCalls = [
        {
          id: 'tool-1',
          name: 'get_api_data',
          arguments: { endpoint: '/status' },
        },
      ];

      const mockResponse = {
        text: 'Let me check the API status...',
        toolCalls: mockToolCalls,
      };

      const mockLLM = {
        generateResponse: jest.fn().mockResolvedValue(mockResponse),
        registerTool: jest.fn(),
      };

      (LLMService as jest.Mock).mockImplementation(() => mockLLM);
      pipeline = new Pipeline(sessionManager, mockOptions);

      await pipeline.processUserMessage(mockSessionId, 'What is the API status?');

      expect(mockLLM.generateResponse).toHaveBeenCalled();
    });

    it('should maintain conversation history', async () => {
      const mockLLM = {
        generateResponse: jest.fn()
          .mockResolvedValueOnce({ text: 'Response 1', toolCalls: [] })
          .mockResolvedValueOnce({ text: 'Response 2', toolCalls: [] }),
        registerTool: jest.fn(),
      };

      (LLMService as jest.Mock).mockImplementation(() => mockLLM);
      pipeline = new Pipeline(sessionManager, mockOptions);

      await pipeline.processUserMessage(mockSessionId, 'Message 1');
      await pipeline.processUserMessage(mockSessionId, 'Message 2');

      expect(mockLLM.generateResponse).toHaveBeenCalledTimes(2);
    });
  });

  describe('Verification Flow', () => {
    const mockSessionId = 'test-session-789';

    beforeEach(() => {
      sessionManager.createSession(mockSessionId);
    });

    it('should verify LLM response when enabled', async () => {
      const mockLLMResponse = 'The system has 10 active users.';
      const mockVerificationResult = {
        verified: true,
        confidence: 0.9,
        citations: [],
        warnings: [],
        modifiedResponse: null,
      };

      const mockLLM = {
        generateResponse: jest.fn().mockResolvedValue({
          text: mockLLMResponse,
          toolCalls: [],
        }),
        registerTool: jest.fn(),
      };

      const mockVerification = {
        verify: jest.fn().mockResolvedValue(mockVerificationResult),
        isEnabled: jest.fn().mockReturnValue(true),
      };

      (LLMService as jest.Mock).mockImplementation(() => mockLLM);
      (VerificationClient as jest.Mock).mockImplementation(() => mockVerification);

      pipeline = new Pipeline(sessionManager, mockOptions);
      await pipeline.processUserMessage(mockSessionId, 'How many users are active?');

      expect(mockVerification.verify).toHaveBeenCalledWith({
        sessionId: mockSessionId,
        responseText: mockLLMResponse,
        context: expect.any(Object),
      });
    });

    it('should handle unverified responses with warnings', async () => {
      const mockLLMResponse = 'The system has 999 critical errors.';
      const mockVerificationResult = {
        verified: false,
        confidence: 0.3,
        citations: [],
        warnings: ['Unverified claim about error count'],
        modifiedResponse: mockLLMResponse + '\n\nNote: This information could not be verified.',
      };

      const mockLLM = {
        generateResponse: jest.fn().mockResolvedValue({
          text: mockLLMResponse,
          toolCalls: [],
        }),
        registerTool: jest.fn(),
      };

      const mockVerification = {
        verify: jest.fn().mockResolvedValue(mockVerificationResult),
        isEnabled: jest.fn().mockReturnValue(true),
      };

      (LLMService as jest.Mock).mockImplementation(() => mockLLM);
      (VerificationClient as jest.Mock).mockImplementation(() => mockVerification);

      pipeline = new Pipeline(sessionManager, mockOptions);
      await pipeline.processUserMessage(mockSessionId, 'How many errors are there?');

      expect(mockVerification.verify).toHaveBeenCalled();
    });

    it('should skip verification when disabled', async () => {
      const disabledOptions = {
        ...mockOptions,
        verificationEnabled: false,
      };

      const mockVerification = {
        verify: jest.fn(),
        isEnabled: jest.fn().mockReturnValue(false),
      };

      (VerificationClient as jest.Mock).mockImplementation(() => mockVerification);

      pipeline = new Pipeline(sessionManager, disabledOptions);
      await pipeline.processUserMessage(mockSessionId, 'Test message');

      // Verification should not be called when disabled
      expect(mockVerification.verify).not.toHaveBeenCalled();
    });
  });

  describe('TTS Processing Flow', () => {
    const mockSessionId = 'test-session-tts';

    beforeEach(() => {
      sessionManager.createSession(mockSessionId);
    });

    it('should convert text to speech', async () => {
      const mockAudioBuffer = Buffer.from('mock-audio-output');
      const mockTTS = {
        synthesize: jest.fn().mockResolvedValue(mockAudioBuffer),
      };

      (TTSService as jest.Mock).mockImplementation(() => mockTTS);
      pipeline = new Pipeline(sessionManager, mockOptions);

      const text = 'Hello, this is a test response.';
      await pipeline.synthesizeSpeech(mockSessionId, text);

      expect(mockTTS.synthesize).toHaveBeenCalledWith(text);
    });

    it('should handle TTS errors gracefully', async () => {
      const mockTTS = {
        synthesize: jest.fn().mockRejectedValue(new Error('TTS service unavailable')),
      };

      (TTSService as jest.Mock).mockImplementation(() => mockTTS);
      pipeline = new Pipeline(sessionManager, mockOptions);

      const text = 'Test response';

      await expect(
        pipeline.synthesizeSpeech(mockSessionId, text)
      ).rejects.toThrow('TTS service unavailable');
    });
  });

  describe('End-to-End Pipeline Flow', () => {
    const mockSessionId = 'test-session-e2e';

    beforeEach(() => {
      sessionManager.createSession(mockSessionId);
    });

    it('should complete full pipeline: Audio → ASR → LLM → Verification → TTS', async () => {
      const mockAudioChunk = Buffer.from('user-audio');
      const mockTranscript = {
        text: 'What is the weather?',
        isFinal: true,
        confidence: 0.95,
      };
      const mockLLMResponse = 'The current weather is sunny and 72°F.';
      const mockVerificationResult = {
        verified: true,
        confidence: 0.85,
        citations: [{ source: 'api:weather', verified: true, snippet: 'sunny 72°F', type: 'factual' }],
        warnings: [],
        modifiedResponse: null,
      };
      const mockAudioOutput = Buffer.from('tts-audio-output');

      // Mock all services
      const mockASR = {
        processAudioChunk: jest.fn().mockResolvedValue(mockTranscript),
      };

      const mockLLM = {
        generateResponse: jest.fn().mockResolvedValue({
          text: mockLLMResponse,
          toolCalls: [],
        }),
        registerTool: jest.fn(),
      };

      const mockVerification = {
        verify: jest.fn().mockResolvedValue(mockVerificationResult),
        isEnabled: jest.fn().mockReturnValue(true),
      };

      const mockTTS = {
        synthesize: jest.fn().mockResolvedValue(mockAudioOutput),
      };

      (ASRService as jest.Mock).mockImplementation(() => mockASR);
      (LLMService as jest.Mock).mockImplementation(() => mockLLM);
      (VerificationClient as jest.Mock).mockImplementation(() => mockVerification);
      (TTSService as jest.Mock).mockImplementation(() => mockTTS);

      pipeline = new Pipeline(sessionManager, mockOptions);

      // Step 1: Process audio
      await pipeline.processAudioChunk(mockSessionId, mockAudioChunk);

      // Step 2: Process transcript through LLM
      await pipeline.processUserMessage(mockSessionId, mockTranscript.text);

      // Step 3: Synthesize response
      await pipeline.synthesizeSpeech(mockSessionId, mockLLMResponse);

      // Verify all services were called
      expect(mockASR.processAudioChunk).toHaveBeenCalled();
      expect(mockLLM.generateResponse).toHaveBeenCalled();
      expect(mockVerification.verify).toHaveBeenCalled();
      expect(mockTTS.synthesize).toHaveBeenCalled();
    });

    it('should handle partial failures in pipeline', async () => {
      const mockASR = {
        processAudioChunk: jest.fn().mockResolvedValue({
          text: 'Test message',
          isFinal: true,
          confidence: 0.9,
        }),
      };

      const mockLLM = {
        generateResponse: jest.fn().mockRejectedValue(new Error('LLM API error')),
        registerTool: jest.fn(),
      };

      (ASRService as jest.Mock).mockImplementation(() => mockASR);
      (LLMService as jest.Mock).mockImplementation(() => mockLLM);

      pipeline = new Pipeline(sessionManager, mockOptions);

      const audioChunk = Buffer.from('test-audio');
      await pipeline.processAudioChunk(mockSessionId, audioChunk);

      await expect(
        pipeline.processUserMessage(mockSessionId, 'Test message')
      ).rejects.toThrow('LLM API error');
    });
  });

  describe('Session Management', () => {
    it('should create new session', () => {
      const sessionId = 'new-session';
      sessionManager.createSession(sessionId);

      expect(sessionManager.hasSession(sessionId)).toBe(true);
    });

    it('should remove session', () => {
      const sessionId = 'temp-session';
      sessionManager.createSession(sessionId);
      sessionManager.removeSession(sessionId);

      expect(sessionManager.hasSession(sessionId)).toBe(false);
    });

    it('should handle multiple concurrent sessions', () => {
      const session1 = 'session-1';
      const session2 = 'session-2';
      const session3 = 'session-3';

      sessionManager.createSession(session1);
      sessionManager.createSession(session2);
      sessionManager.createSession(session3);

      expect(sessionManager.hasSession(session1)).toBe(true);
      expect(sessionManager.hasSession(session2)).toBe(true);
      expect(sessionManager.hasSession(session3)).toBe(true);
    });
  });

  describe('Error Handling', () => {
    const mockSessionId = 'error-test-session';

    beforeEach(() => {
      sessionManager.createSession(mockSessionId);
    });

    it('should emit error event on ASR failure', async () => {
      const mockASR = {
        processAudioChunk: jest.fn().mockRejectedValue(new Error('ASR failed')),
      };

      (ASRService as jest.Mock).mockImplementation(() => mockASR);
      pipeline = new Pipeline(sessionManager, mockOptions);

      const errorHandler = jest.fn();
      pipeline.on('error', errorHandler);

      const audioChunk = Buffer.from('test-audio');

      await expect(
        pipeline.processAudioChunk(mockSessionId, audioChunk)
      ).rejects.toThrow('ASR failed');

      expect(errorHandler).toHaveBeenCalled();
    });

    it('should emit error event on LLM failure', async () => {
      const mockLLM = {
        generateResponse: jest.fn().mockRejectedValue(new Error('LLM timeout')),
        registerTool: jest.fn(),
      };

      (LLMService as jest.Mock).mockImplementation(() => mockLLM);
      pipeline = new Pipeline(sessionManager, mockOptions);

      const errorHandler = jest.fn();
      pipeline.on('error', errorHandler);

      await expect(
        pipeline.processUserMessage(mockSessionId, 'Test')
      ).rejects.toThrow('LLM timeout');

      expect(errorHandler).toHaveBeenCalled();
    });

    it('should handle verification service failures gracefully', async () => {
      const mockLLM = {
        generateResponse: jest.fn().mockResolvedValue({
          text: 'Response text',
          toolCalls: [],
        }),
        registerTool: jest.fn(),
      };

      const mockVerification = {
        verify: jest.fn().mockRejectedValue(new Error('Verification service down')),
        isEnabled: jest.fn().mockReturnValue(true),
      };

      (LLMService as jest.Mock).mockImplementation(() => mockLLM);
      (VerificationClient as jest.Mock).mockImplementation(() => mockVerification);

      pipeline = new Pipeline(sessionManager, mockOptions);

      // Should continue despite verification failure
      const errorHandler = jest.fn();
      pipeline.on('error', errorHandler);

      await pipeline.processUserMessage(mockSessionId, 'Test message');

      expect(mockLLM.generateResponse).toHaveBeenCalled();
    });
  });

  describe('Performance and Latency', () => {
    const mockSessionId = 'perf-test-session';

    beforeEach(() => {
      sessionManager.createSession(mockSessionId);
    });

    it('should track processing time', async () => {
      const mockLLM = {
        generateResponse: jest.fn().mockImplementation(async () => {
          // Simulate processing delay
          await new Promise(resolve => setTimeout(resolve, 100));
          return { text: 'Response', toolCalls: [] };
        }),
        registerTool: jest.fn(),
      };

      (LLMService as jest.Mock).mockImplementation(() => mockLLM);
      pipeline = new Pipeline(sessionManager, mockOptions);

      const start = Date.now();
      await pipeline.processUserMessage(mockSessionId, 'Test');
      const duration = Date.now() - start;

      expect(duration).toBeGreaterThanOrEqual(100);
    });

    it('should warn on latency exceeding threshold', async () => {
      const slowLLM = {
        generateResponse: jest.fn().mockImplementation(async () => {
          await new Promise(resolve => setTimeout(resolve, 600));
          return { text: 'Slow response', toolCalls: [] };
        }),
        registerTool: jest.fn(),
      };

      (LLMService as jest.Mock).mockImplementation(() => slowLLM);
      pipeline = new Pipeline(sessionManager, mockOptions);

      const warningHandler = jest.fn();
      pipeline.on('latency-warning', warningHandler);

      await pipeline.processUserMessage(mockSessionId, 'Test');

      // Latency exceeds maxLatencyMs (500ms)
      expect(warningHandler).toHaveBeenCalled();
    });
  });
});
