import { TTSService, TTSConfig, SpeechResult } from './index';

describe('TTSService', () => {
  let ttsService: TTSService;
  const mockApiKey = 'test-openai-key';
  let mockFetch: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    mockFetch = jest.fn();
    global.fetch = mockFetch;

    const config: TTSConfig = {
      apiKey: mockApiKey,
      model: 'tts-1-hd',
      voice: 'nova',
      speed: 1.0,
    };

    ttsService = new TTSService(config);
  });

  describe('Constructor', () => {
    it('should initialize with provided config', () => {
      expect(ttsService).toBeInstanceOf(TTSService);
    });

    it('should use default values for optional config', () => {
      const minimalConfig: TTSConfig = {
        apiKey: mockApiKey,
      };
      const service = new TTSService(minimalConfig);
      expect(service).toBeInstanceOf(TTSService);
    });
  });

  describe('synthesize()', () => {
    it('should synthesize speech from text', async () => {
      const mockAudioData = Buffer.from('mock-audio-data');

      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => mockAudioData.buffer,
      });

      const result = await ttsService.synthesize('Hello world');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/audio/speech',
        expect.objectContaining({
          method: 'POST',
          headers: {
            Authorization: `Bearer ${mockApiKey}`,
            'Content-Type': 'application/json',
          },
        })
      );

      expect(result.audio).toBeInstanceOf(Buffer);
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('should include correct request parameters', async () => {
      const mockAudioData = Buffer.from('mock-audio-data');

      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => mockAudioData.buffer,
      });

      await ttsService.synthesize('Test text');

      const callArgs = mockFetch.mock.calls[0];
      const requestBody = JSON.parse(callArgs[1].body);

      expect(requestBody).toEqual({
        model: 'tts-1-hd',
        input: 'Test text',
        voice: 'nova',
        speed: 1.0,
        response_format: 'pcm',
      });
    });

    it('should handle API errors gracefully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'Bad request',
      });

      await expect(ttsService.synthesize('Hello')).rejects.toThrow();
    });

    it('should throw error on non-retryable failures', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'Invalid input',
      });

      await expect(ttsService.synthesize('Test')).rejects.toThrow(
        'TTS API error: Invalid input'
      );
    });

    it('should handle network errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network failure'));

      await expect(ttsService.synthesize('Hello')).rejects.toThrow(
        'Network failure'
      );
    });

    it('should return audio buffer with duration', async () => {
      const mockAudioData = Buffer.from('test-audio-data');

      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => mockAudioData.buffer,
      });

      const result = await ttsService.synthesize('Test speech');

      expect(result).toEqual({
        audio: expect.any(Buffer),
        duration: expect.any(Number),
      });
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('should synthesize empty text', async () => {
      const mockAudioData = Buffer.from('');

      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => mockAudioData.buffer,
      });

      const result = await ttsService.synthesize('');

      expect(result.audio).toBeInstanceOf(Buffer);
    });

    it('should synthesize long text', async () => {
      const mockAudioData = Buffer.from('long-audio-data');
      const longText = 'This is a very long text. '.repeat(100);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => mockAudioData.buffer,
      });

      const result = await ttsService.synthesize(longText);

      expect(result.audio).toBeInstanceOf(Buffer);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/audio/speech',
        expect.objectContaining({
          body: expect.stringContaining(longText),
        })
      );
    });
  });

  describe('synthesizeStream()', () => {
    it('should stream synthesized speech', async () => {
      const mockAudioData = Buffer.from('mock-mp3-audio');
      const chunks: Buffer[] = [];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => mockAudioData.buffer,
      });

      await ttsService.synthesizeStream('Hello streaming', (chunk) => {
        chunks.push(chunk);
      });

      expect(chunks.length).toBe(1);
      expect(Buffer.concat(chunks)).toBeInstanceOf(Buffer);
    });

    it('should use MP3 format for streaming', async () => {
      const mockAudioData = Buffer.from('mp3-data');

      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => mockAudioData.buffer,
      });

      await ttsService.synthesizeStream('Test', () => {});

      const callArgs = mockFetch.mock.calls[0];
      const requestBody = JSON.parse(callArgs[1].body);

      expect(requestBody.response_format).toBe('mp3');
    });

    it('should call chunk callback with audio data', async () => {
      const mockAudioData = Buffer.from('test-mp3-audio');
      const onChunk = jest.fn();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => mockAudioData.buffer,
      });

      await ttsService.synthesizeStream('Hello', onChunk);

      expect(onChunk).toHaveBeenCalledTimes(1);
      expect(onChunk).toHaveBeenCalledWith(expect.any(Buffer));
    });

    it('should handle streaming errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Server error',
      });

      const onChunk = jest.fn();

      await expect(
        ttsService.synthesizeStream('Test', onChunk)
      ).rejects.toThrow();
    });

    it('should handle network failures during streaming', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection failed'));

      const onChunk = jest.fn();

      await expect(
        ttsService.synthesizeStream('Test', onChunk)
      ).rejects.toThrow('Connection failed');
      expect(onChunk).not.toHaveBeenCalled();
    });

    it('should stream large audio data', async () => {
      const largeAudioData = Buffer.alloc(100000);
      const onChunk = jest.fn();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => largeAudioData.buffer,
      });

      await ttsService.synthesizeStream('Large text content', onChunk);

      expect(onChunk).toHaveBeenCalled();
      const receivedBuffer = onChunk.mock.calls[0][0];
      expect(receivedBuffer.length).toBe(100000);
    });
  });

  describe('Configuration', () => {
    it('should use custom voice', async () => {
      const customConfig: TTSConfig = {
        apiKey: mockApiKey,
        voice: 'alloy',
      };

      const customService = new TTSService(customConfig);
      const mockAudioData = Buffer.from('audio');

      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => mockAudioData.buffer,
      });

      await customService.synthesize('Test');

      const callArgs = mockFetch.mock.calls[0];
      const requestBody = JSON.parse(callArgs[1].body);

      expect(requestBody.voice).toBe('alloy');
    });

    it('should use custom speed', async () => {
      const customConfig: TTSConfig = {
        apiKey: mockApiKey,
        speed: 1.5,
      };

      const customService = new TTSService(customConfig);
      const mockAudioData = Buffer.from('audio');

      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => mockAudioData.buffer,
      });

      await customService.synthesize('Test');

      const callArgs = mockFetch.mock.calls[0];
      const requestBody = JSON.parse(callArgs[1].body);

      expect(requestBody.speed).toBe(1.5);
    });

    it('should use custom model', async () => {
      const customConfig: TTSConfig = {
        apiKey: mockApiKey,
        model: 'tts-1',
      };

      const customService = new TTSService(customConfig);
      const mockAudioData = Buffer.from('audio');

      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => mockAudioData.buffer,
      });

      await customService.synthesize('Test');

      const callArgs = mockFetch.mock.calls[0];
      const requestBody = JSON.parse(callArgs[1].body);

      expect(requestBody.model).toBe('tts-1');
    });
  });

  describe('Error Handling', () => {
    it('should handle 429 rate limit errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => 'Rate limit exceeded',
      });

      await expect(ttsService.synthesize('Test')).rejects.toThrow();
    });

    it('should handle 500 server errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal server error',
      });

      await expect(ttsService.synthesize('Test')).rejects.toThrow();
    });

    it('should handle invalid response format', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => {
          throw new Error('Invalid response format');
        },
      });

      await expect(ttsService.synthesize('Test')).rejects.toThrow(
        'Invalid response format'
      );
    });
  });

  describe('Integration Scenarios', () => {
    it('should synthesize multiple requests sequentially', async () => {
      const mockAudioData1 = Buffer.from('audio1');
      const mockAudioData2 = Buffer.from('audio2');

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: async () => mockAudioData1.buffer,
        })
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: async () => mockAudioData2.buffer,
        });

      const result1 = await ttsService.synthesize('First text');
      const result2 = await ttsService.synthesize('Second text');

      expect(result1.audio).toBeInstanceOf(Buffer);
      expect(result2.audio).toBeInstanceOf(Buffer);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should handle mixed synthesize and stream calls', async () => {
      const mockAudioData1 = Buffer.from('pcm-audio');
      const mockAudioData2 = Buffer.from('mp3-audio');

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: async () => mockAudioData1.buffer,
        })
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: async () => mockAudioData2.buffer,
        });

      const result1 = await ttsService.synthesize('Regular synthesis');

      const chunks: Buffer[] = [];
      await ttsService.synthesizeStream('Streaming synthesis', (chunk) => {
        chunks.push(chunk);
      });

      expect(result1.audio).toBeInstanceOf(Buffer);
      expect(chunks.length).toBe(1);

      // Verify different formats were used
      const call1Body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const call2Body = JSON.parse(mockFetch.mock.calls[1][1].body);

      expect(call1Body.response_format).toBe('pcm');
      expect(call2Body.response_format).toBe('mp3');
    });

    it('should recover from temporary failures', async () => {
      // First call fails with 400 (non-retryable)
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'Bad request',
      });

      await expect(ttsService.synthesize('First')).rejects.toThrow();

      // Second call succeeds
      const mockAudioData = Buffer.from('success-audio');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => mockAudioData.buffer,
      });

      const result = await ttsService.synthesize('Second');
      expect(result.audio).toBeInstanceOf(Buffer);
    });
  });
});
