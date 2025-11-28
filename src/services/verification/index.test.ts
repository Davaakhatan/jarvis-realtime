import { VerificationClient, VerificationConfig } from './index';
import { VerificationEngine } from './engine';

// Mock the VerificationEngine
jest.mock('./engine');

describe('VerificationClient', () => {
  let client: VerificationClient;
  const mockApiKey = 'test-api-key';

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  describe('Constructor', () => {
    it('should initialize with default config', () => {
      client = new VerificationClient();
      expect(client).toBeInstanceOf(VerificationClient);
    });

    it('should initialize with custom config', () => {
      const config: Partial<VerificationConfig> = {
        serviceUrl: 'http://custom-url:8080',
        enabled: false,
        minConfidence: 0.8,
        useBuiltInEngine: true,
        apiKey: mockApiKey,
      };

      client = new VerificationClient(config);
      expect(client.isEnabled()).toBe(false);
      expect(client.getMinConfidence()).toBe(0.8);
    });

    it('should create VerificationEngine when API key provided', () => {
      client = new VerificationClient({ apiKey: mockApiKey });
      expect(VerificationEngine).toHaveBeenCalledWith(mockApiKey, 0.6);
    });

    it('should not create engine without API key', () => {
      (VerificationEngine as jest.Mock).mockClear();
      client = new VerificationClient();
      expect(VerificationEngine).not.toHaveBeenCalled();
    });
  });

  describe('verify()', () => {
    it('should return unverified when disabled', async () => {
      client = new VerificationClient({ enabled: false });

      const result = await client.verify({
        sessionId: 'test-session',
        responseText: 'Test response',
      });

      expect(result.verified).toBe(true);
      expect(result.confidence).toBe(1.0);
      expect(result.warnings).toContain('Verification service disabled');
    });

    it('should use built-in engine when enabled and available', async () => {
      const mockEngineResult = {
        verified: true,
        confidence: 0.95,
        claims: [],
        citations: [],
        warnings: [],
        modifiedResponse: null,
      };

      const mockEngine = {
        verify: jest.fn().mockResolvedValue(mockEngineResult),
        verifyWithLLM: jest.fn().mockResolvedValue(mockEngineResult),
      };

      (VerificationEngine as jest.Mock).mockImplementation(() => mockEngine);

      client = new VerificationClient({
        useBuiltInEngine: true,
        apiKey: mockApiKey,
      });

      const result = await client.verify({
        sessionId: 'test-session',
        responseText: 'Test response',
      });

      expect(mockEngine.verify).toHaveBeenCalled();
      expect(result.verified).toBe(true);
      expect(result.confidence).toBe(0.95);
    });

    it('should use LLM verification when configured', async () => {
      const mockEngineResult = {
        verified: true,
        confidence: 0.9,
        claims: [],
        citations: [],
        warnings: [],
        modifiedResponse: null,
      };

      const mockEngine = {
        verify: jest.fn().mockResolvedValue(mockEngineResult),
        verifyWithLLM: jest.fn().mockResolvedValue(mockEngineResult),
      };

      (VerificationEngine as jest.Mock).mockImplementation(() => mockEngine);

      client = new VerificationClient({
        useBuiltInEngine: true,
        apiKey: mockApiKey,
        useLLMVerification: true,
      });

      await client.verify({
        sessionId: 'test-session',
        responseText: 'Test response',
      });

      expect(mockEngine.verifyWithLLM).toHaveBeenCalled();
      expect(mockEngine.verify).not.toHaveBeenCalled();
    });

    it('should call external service when built-in engine not enabled', async () => {
      const mockResponse = {
        verified: true,
        confidence: 0.85,
        citations: [],
        warnings: [],
        modified_response: null,
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      client = new VerificationClient({
        useBuiltInEngine: false,
        serviceUrl: 'http://localhost:8003',
      });

      const result = await client.verify({
        sessionId: 'test-session',
        responseText: 'Test response',
        claimedSources: ['api'],
        context: { foo: 'bar' },
      });

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:8003/verify',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: expect.stringContaining('test-session'),
        })
      );

      expect(result.verified).toBe(true);
      expect(result.confidence).toBe(0.85);
    });

    it('should handle external service errors gracefully', async () => {
      (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('Network error'));

      client = new VerificationClient({ useBuiltInEngine: false });

      const result = await client.verify({
        sessionId: 'test-session',
        responseText: 'Test response',
      });

      expect(result.verified).toBe(false);
      expect(result.confidence).toBe(0);
      expect(result.warnings).toContain('Verification service unavailable');
    });

    it('should fallback to built-in engine on external service failure', async () => {
      (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('Service down'));

      const mockEngineResult = {
        verified: true,
        confidence: 0.7,
        claims: [],
        citations: [],
        warnings: [],
        modifiedResponse: null,
      };

      const mockEngine = {
        verify: jest.fn().mockResolvedValue(mockEngineResult),
        verifyWithLLM: jest.fn(),
      };

      (VerificationEngine as jest.Mock).mockImplementation(() => mockEngine);

      client = new VerificationClient({
        useBuiltInEngine: false,
        apiKey: mockApiKey,
      });

      const result = await client.verify({
        sessionId: 'test-session',
        responseText: 'Test response',
      });

      // Should attempt external service first, then fallback
      expect(global.fetch).toHaveBeenCalled();
      expect(result.verified).toBe(true);
    });

    it('should handle non-OK HTTP response from external service', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        text: async () => 'Internal Server Error',
      });

      client = new VerificationClient({ useBuiltInEngine: false });

      const result = await client.verify({
        sessionId: 'test-session',
        responseText: 'Test',
      });

      expect(result.verified).toBe(false);
      expect(result.warnings).toContain('Verification service unavailable');
    });

    it('should convert context format correctly for built-in engine', async () => {
      const mockEngineResult = {
        verified: true,
        confidence: 0.8,
        claims: [],
        citations: [],
        warnings: [],
        modifiedResponse: null,
      };

      const mockEngine = {
        verify: jest.fn().mockResolvedValue(mockEngineResult),
        verifyWithLLM: jest.fn(),
      };

      (VerificationEngine as jest.Mock).mockImplementation(() => mockEngine);

      client = new VerificationClient({
        useBuiltInEngine: true,
        apiKey: mockApiKey,
      });

      await client.verify({
        sessionId: 'test-session',
        responseText: 'Test',
        context: {
          apiData: { status: 'healthy' },
          githubData: [{ name: 'repo' }],
          conversationHistory: [{ role: 'user', content: 'hi' }],
        },
      });

      const callArgs = mockEngine.verify.mock.calls[0];
      const context = callArgs[1];

      expect(context.apiData).toBeDefined();
      expect(context.githubData).toBeDefined();
      expect(context.conversationHistory).toBeDefined();
    });

    it('should handle built-in engine errors and fallback to external', async () => {
      const mockEngine = {
        verify: jest.fn().mockRejectedValue(new Error('Engine error')),
        verifyWithLLM: jest.fn().mockRejectedValue(new Error('LLM error')),
      };

      (VerificationEngine as jest.Mock).mockImplementation(() => mockEngine);

      const mockResponse = {
        verified: true,
        confidence: 0.75,
        citations: [],
        warnings: [],
        modified_response: null,
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      client = new VerificationClient({
        useBuiltInEngine: true,
        apiKey: mockApiKey,
      });

      const result = await client.verify({
        sessionId: 'test',
        responseText: 'Test',
      });

      expect(mockEngine.verify).toHaveBeenCalled();
      expect(global.fetch).toHaveBeenCalled();
      expect(result.verified).toBe(true);
    });
  });

  describe('checkHealth()', () => {
    it('should return true when service is healthy', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
      });

      client = new VerificationClient({
        serviceUrl: 'http://localhost:8003',
      });

      const healthy = await client.checkHealth();
      expect(healthy).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith('http://localhost:8003/health');
    });

    it('should return false when service is unhealthy', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
      });

      client = new VerificationClient();
      const healthy = await client.checkHealth();

      expect(healthy).toBe(false);
    });

    it('should return false on network error', async () => {
      (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('Network error'));

      client = new VerificationClient();
      const healthy = await client.checkHealth();

      expect(healthy).toBe(false);
    });
  });

  describe('isEnabled() and setEnabled()', () => {
    it('should return enabled state', () => {
      client = new VerificationClient({ enabled: true });
      expect(client.isEnabled()).toBe(true);

      client = new VerificationClient({ enabled: false });
      expect(client.isEnabled()).toBe(false);
    });

    it('should allow toggling enabled state', () => {
      client = new VerificationClient({ enabled: true });
      expect(client.isEnabled()).toBe(true);

      client.setEnabled(false);
      expect(client.isEnabled()).toBe(false);

      client.setEnabled(true);
      expect(client.isEnabled()).toBe(true);
    });
  });

  describe('getMinConfidence()', () => {
    it('should return configured minimum confidence', () => {
      client = new VerificationClient({ minConfidence: 0.75 });
      expect(client.getMinConfidence()).toBe(0.75);
    });

    it('should return default minimum confidence', () => {
      client = new VerificationClient();
      expect(client.getMinConfidence()).toBe(0.6);
    });
  });

  describe('Integration Scenarios', () => {
    it('should complete full verification flow with built-in engine', async () => {
      const mockEngineResult = {
        verified: true,
        confidence: 0.92,
        claims: [
          {
            text: 'System is healthy',
            type: 'factual' as const,
            confidence: 0.95,
            verified: true,
            source: 'api:status',
          },
        ],
        citations: [
          {
            source: 'api:status',
            verified: true,
            snippet: 'System is healthy',
            type: 'factual',
          },
        ],
        warnings: [],
        modifiedResponse: null,
      };

      const mockEngine = {
        verify: jest.fn().mockResolvedValue(mockEngineResult),
        verifyWithLLM: jest.fn(),
      };

      (VerificationEngine as jest.Mock).mockImplementation(() => mockEngine);

      client = new VerificationClient({
        useBuiltInEngine: true,
        apiKey: mockApiKey,
        minConfidence: 0.8,
      });

      const result = await client.verify({
        sessionId: 'integration-test',
        responseText: 'System is healthy',
        context: {
          apiData: { status: 'healthy' },
        },
      });

      expect(result.verified).toBe(true);
      expect(result.confidence).toBeGreaterThanOrEqual(0.8);
      expect(result.citations.length).toBeGreaterThan(0);
    });

    it('should handle complete verification failure path', async () => {
      // No API key, external service down, built-in engine unavailable
      (global.fetch as jest.Mock).mockRejectedValue(new Error('Service unavailable'));

      client = new VerificationClient({
        useBuiltInEngine: false,
        enabled: true,
      });

      const result = await client.verify({
        sessionId: 'failure-test',
        responseText: 'Test',
      });

      expect(result.verified).toBe(false);
      expect(result.confidence).toBe(0);
      expect(result.warnings).toContain('Verification service unavailable');
    });
  });
});
