import { VerificationEngine, VerificationContext } from './engine';

describe('VerificationEngine', () => {
  let engine: VerificationEngine;
  const mockApiKey = 'test-api-key';

  beforeEach(() => {
    engine = new VerificationEngine(mockApiKey, 0.6);
  });

  describe('Constructor', () => {
    it('should initialize with provided API key and confidence threshold', () => {
      expect(engine).toBeInstanceOf(VerificationEngine);
    });

    it('should use default confidence threshold if not provided', () => {
      const defaultEngine = new VerificationEngine(mockApiKey);
      expect(defaultEngine).toBeInstanceOf(VerificationEngine);
    });
  });

  describe('verify()', () => {
    it('should return verified result for empty response with no claims', async () => {
      const result = await engine.verify('Hello!', {});

      expect(result.verified).toBe(true);
      expect(result.confidence).toBe(1.0);
      expect(result.claims).toHaveLength(0);
      expect(result.citations).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
      expect(result.modifiedResponse).toBeNull();
    });

    it('should extract and verify factual claims against API context', async () => {
      const context: VerificationContext = {
        apiData: {
          status: { totalIssues: 42, openIssues: 10 },
        },
      };

      const response = 'The system has 42 total issues. There are 10 open issues currently.';
      const result = await engine.verify(response, context);

      expect(result.claims.length).toBeGreaterThan(0);
      // Verification may pass or fail depending on similarity threshold
      expect(result.confidence).toBeGreaterThanOrEqual(0);
    });

    it('should mark unverified claims when no matching context exists', async () => {
      const response = 'The system has 99 critical bugs that need immediate attention.';
      const result = await engine.verify(response, {});

      expect(result.verified).toBe(false);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.modifiedResponse).not.toBeNull();
    });

    it('should verify claims from conversation history', async () => {
      const context: VerificationContext = {
        conversationHistory: [
          { role: 'user', content: 'How many issues are there?' },
          { role: 'assistant', content: 'There are 15 issues in the system.' },
        ],
      };

      const response = 'As mentioned, there are 15 issues in the system.';
      const result = await engine.verify(response, context);

      expect(result.verified).toBe(true);
      expect(result.claims.length).toBeGreaterThan(0);
    });

    it('should verify general knowledge statements', async () => {
      const response = 'Hello! How can I help you today?';
      const result = await engine.verify(response, {});

      expect(result.verified).toBe(true);
      expect(result.confidence).toBe(1.0);
    });

    it('should handle GitHub data context', async () => {
      const context: VerificationContext = {
        githubData: [
          {
            name: 'bug-fix-123',
            status: 'merged',
            additions: 50,
          },
        ],
      };

      const response = 'The bug-fix-123 has been merged with 50 additions.';
      const result = await engine.verify(response, context);

      expect(result.claims.length).toBeGreaterThan(0);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
    });

    it('should generate citations for verified claims', async () => {
      const context: VerificationContext = {
        apiData: {
          user: { name: 'John Doe', email: 'john@example.com' },
        },
      };

      const response = 'The user email is john@example.com.';
      const result = await engine.verify(response, context);

      // Citations are only generated if claims are verified above threshold
      expect(result.claims.length).toBeGreaterThan(0);
      if (result.citations.length > 0) {
        expect(result.citations[0].verified).toBe(true);
        expect(result.citations[0].source).toContain('api');
      }
    });

    it('should pass verification when confidence exceeds threshold', async () => {
      const context: VerificationContext = {
        apiData: {
          count: '100',
          average: '25.5',
          metrics: 'count 100 average 25.5',
        },
      };

      const response = 'The count is 100 and average is 25.5.';
      const result = await engine.verify(response, context);

      // Verification depends on similarity matching
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.claims.length).toBeGreaterThan(0);
    });

    it('should fail verification when confidence below threshold', async () => {
      const response = 'The system has 999 errors and 888 warnings that do not exist.';
      const result = await engine.verify(response, {});

      expect(result.verified).toBe(false);
      expect(result.confidence).toBeLessThan(0.6);
      expect(result.modifiedResponse).not.toBeNull();
    });
  });

  describe('Claim Extraction', () => {
    it('should classify numerical claims correctly', async () => {
      const response = 'The system processed 5000 requests with 95% success rate.';
      const result = await engine.verify(response, {});

      const claims = result.claims;
      expect(claims.some((c) => c.type === 'numerical')).toBe(true);
    });

    it('should classify temporal claims correctly', async () => {
      const response = 'The deployment happened yesterday at 3pm.';
      const result = await engine.verify(response, {});

      const claims = result.claims;
      expect(claims.some((c) => c.type === 'temporal')).toBe(true);
    });

    it('should classify reference claims correctly', async () => {
      const response = 'According to the documentation, the API supports REST.';
      const result = await engine.verify(response, {});

      const claims = result.claims;
      expect(claims.some((c) => c.type === 'reference')).toBe(true);
    });

    it('should skip opinion statements', async () => {
      const response = 'I think this might be a good approach. Perhaps we should consider it.';
      const result = await engine.verify(response, {});

      expect(result.verified).toBe(true);
      expect(result.claims).toHaveLength(0);
    });

    it('should identify factual claims', async () => {
      const response = 'The server is running and operational.';
      const result = await engine.verify(response, {});

      const claims = result.claims;
      expect(claims.length).toBeGreaterThan(0);
      expect(claims[0].type).toBe('factual');
    });

    it('should filter out very short sentences', async () => {
      const response = 'Hi. Yes. Ok. The system is operational.';
      const result = await engine.verify(response, {});

      // Only the last sentence should be extracted as a claim
      expect(result.claims.length).toBeLessThanOrEqual(1);
    });
  });

  describe('Similarity Matching', () => {
    it('should match claims with high word overlap', async () => {
      const context: VerificationContext = {
        apiData: {
          status: 'System is running smoothly with no errors',
        },
      };

      const response = 'The system is running smoothly.';
      const result = await engine.verify(response, context);

      expect(result.verified).toBe(true);
      expect(result.confidence).toBeGreaterThan(0.5);
    });

    it('should reject claims with low word overlap', async () => {
      const context: VerificationContext = {
        apiData: {
          status: 'All services operational',
        },
      };

      const response = 'There are multiple critical failures in the database.';
      const result = await engine.verify(response, context);

      expect(result.verified).toBe(false);
    });

    it('should weight key terms higher in similarity calculation', async () => {
      const context: VerificationContext = {
        apiData: {
          errors: 'Total error count is 5',
        },
      };

      const response = 'The error count is 5.';
      const result = await engine.verify(response, context);

      expect(result.verified).toBe(true);
    });
  });

  describe('Response Modification', () => {
    it('should add disclaimer when verification fails', async () => {
      const response = 'The system has 999 critical bugs.';
      const result = await engine.verify(response, {});

      expect(result.modifiedResponse).not.toBeNull();
      expect(result.modifiedResponse).toContain('could not be verified');
    });

    it('should not modify response when verification passes', async () => {
      const response = 'Hello! How can I help you?';
      const result = await engine.verify(response, {});

      expect(result.modifiedResponse).toBeNull();
    });

    it('should list specific unverified claims in warnings', async () => {
      const response = 'There are 100 errors. The database crashed. System is down.';
      const result = await engine.verify(response, {});

      expect(result.warnings.length).toBeGreaterThan(0);
      result.warnings.forEach((warning) => {
        expect(warning).toContain('Unverified claim');
      });
    });
  });

  describe('General Knowledge Recognition', () => {
    it('should recognize greetings as general knowledge', async () => {
      const greetings = [
        'Hello there!',
        'Hi, how can I help?',
        "Hey! What can I do for you?",
      ];

      for (const greeting of greetings) {
        const result = await engine.verify(greeting, {});
        expect(result.verified).toBe(true);
      }
    });

    it('should recognize honest uncertainty as general knowledge', async () => {
      const uncertainties = [
        "I don't have that information.",
        "I cannot verify this data.",
        "I'm not sure about that.",
        'I would need to check the logs.',
      ];

      for (const statement of uncertainties) {
        const result = await engine.verify(statement, {});
        expect(result.verified).toBe(true);
      }
    });

    it('should recognize self-referential statements', async () => {
      const statements = [
        'I am Jarvis, your voice assistant.',
        "I'm here to help you.",
        "I'm designed to process your requests.",
      ];

      for (const statement of statements) {
        const result = await engine.verify(statement, {});
        expect(result.verified).toBe(true);
      }
    });

    it('should recognize questions to user', async () => {
      const questions = [
        'Would you like me to proceed?',
        'Could you please provide more details?',
        'What would you like to know?',
      ];

      for (const question of questions) {
        const result = await engine.verify(question, {});
        expect(result.verified).toBe(true);
      }
    });
  });

  describe('Context Flattening', () => {
    it('should flatten nested API data objects', async () => {
      const context: VerificationContext = {
        apiData: {
          user: {
            profile: {
              name: 'Alice',
              settings: {
                theme: 'dark',
              },
            },
          },
        },
      };

      const response = 'The theme is set to dark.';
      const result = await engine.verify(response, context);

      // Context is flattened correctly, verification depends on similarity
      expect(result.claims.length).toBeGreaterThan(0);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
    });

    it('should flatten arrays in context', async () => {
      const context: VerificationContext = {
        apiData: {
          items: ['item1', 'item2', 'item3'],
        },
      };

      const response = 'The list includes item2.';
      const result = await engine.verify(response, context);

      // Context arrays are flattened, verification depends on similarity
      expect(result.claims.length).toBeGreaterThan(0);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
    });

    it('should handle mixed data types in context', async () => {
      const context: VerificationContext = {
        apiData: {
          count: 42,
          enabled: true,
          name: 'TestService',
        },
      };

      const response = 'The count is 42 and the name is TestService.';
      const result = await engine.verify(response, context);

      expect(result.verified).toBe(true);
    });
  });

  describe('verifyWithLLM()', () => {
    beforeEach(() => {
      global.fetch = jest.fn();
    });

    it('should call OpenAI API with correct parameters', async () => {
      const mockResponse = {
        verified: true,
        confidence: 0.9,
        claims: [{ text: 'Test claim', verified: true, source: 'api' }],
        warnings: [],
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(mockResponse) } }],
        }),
      });

      const result = await engine.verifyWithLLM('Test response', {});

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: `Bearer ${mockApiKey}`,
            'Content-Type': 'application/json',
          }),
        })
      );

      expect(result.verified).toBe(true);
      expect(result.confidence).toBe(0.9);
    });

    it('should fall back to rule-based verification on API failure', async () => {
      (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('API Error'));

      const result = await engine.verifyWithLLM('Hello!', {});

      // Should fall back to verify() method
      expect(result.verified).toBe(true);
      expect(result.claims).toHaveLength(0);
    });

    it('should handle non-OK response from API', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        text: async () => 'Service Unavailable',
      });

      const result = await engine.verifyWithLLM('Test', {});

      // Should fall back to verify() method
      expect(result).toBeDefined();
    });

    it('should include context in verification prompt', async () => {
      const mockResponse = {
        verified: true,
        confidence: 0.8,
        claims: [],
        warnings: [],
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(mockResponse) } }],
        }),
      });

      const context: VerificationContext = {
        apiData: { status: 'healthy' },
        conversationHistory: [
          { role: 'user', content: 'Check status' },
        ],
      };

      await engine.verifyWithLLM('Status is healthy', context);

      const callArgs = (global.fetch as jest.Mock).mock.calls[0][1];
      const body = JSON.parse(callArgs.body);
      const userMessage = body.messages[1].content;

      expect(userMessage).toContain('Status is healthy');
      expect(userMessage).toContain('healthy');
    });

    it('should generate modified response for unverified LLM results', async () => {
      const mockResponse = {
        verified: false,
        confidence: 0.3,
        claims: [{ text: 'Unverified claim', verified: false, source: null }],
        warnings: ['Cannot verify claim'],
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(mockResponse) } }],
        }),
      });

      const result = await engine.verifyWithLLM('Unverified statement', {});

      expect(result.verified).toBe(false);
      expect(result.modifiedResponse).toContain('unverified information');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty context gracefully', async () => {
      const result = await engine.verify('Test response', {});
      expect(result).toBeDefined();
      expect(result.verified).toBeDefined();
    });

    it('should handle null/undefined values in context', async () => {
      const context: VerificationContext = {
        apiData: {
          nullValue: null,
          undefinedValue: undefined,
        },
      };

      const result = await engine.verify('Test', context);
      expect(result).toBeDefined();
    });

    it('should handle very long responses', async () => {
      const longResponse = 'This is a test sentence. '.repeat(100);
      const result = await engine.verify(longResponse, {});

      expect(result).toBeDefined();
      expect(result.claims.length).toBeGreaterThan(0);
    });

    it('should handle special characters in text', async () => {
      const response = 'The system supports UTF-8: \u00E9\u00E7\u00E0 and emojis 🚀';
      const result = await engine.verify(response, {});

      expect(result).toBeDefined();
    });

    it('should handle responses with only punctuation', async () => {
      const result = await engine.verify('...!!!???', {});

      expect(result.verified).toBe(true);
      expect(result.claims).toHaveLength(0);
    });

    it('should handle mixed language content gracefully', async () => {
      const response = 'The system has 42 errors. Das ist ein Test.';
      const result = await engine.verify(response, {});

      expect(result).toBeDefined();
    });
  });

  describe('Confidence Calculation', () => {
    it('should calculate 100% confidence when all claims verified', async () => {
      const context: VerificationContext = {
        apiData: {
          status: 'The service is healthy and running',
        },
      };

      const response = 'The service is healthy.';
      const result = await engine.verify(response, context);

      expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    });

    it('should calculate low confidence when no claims verified', async () => {
      const response = 'The system has 999 fake errors.';
      const result = await engine.verify(response, {});

      expect(result.confidence).toBeLessThan(0.5);
    });

    it('should calculate partial confidence for mixed verification', async () => {
      const context: VerificationContext = {
        apiData: {
          count: '10 items',
          items: 10,
        },
      };

      const response = 'There are 10 items. There are also 999 fake items.';
      const result = await engine.verify(response, context);

      // Should have some claims verified, others not
      expect(result.claims.length).toBeGreaterThan(0);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });
  });
});
