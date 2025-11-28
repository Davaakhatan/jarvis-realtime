import { ASRService, ASRConfig, TranscriptResult } from './index';

describe('ASRService', () => {
  let asrService: ASRService;
  const mockApiKey = 'test-openai-key';
  let mockFetch: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    mockFetch = jest.fn();
    global.fetch = mockFetch;
    global.FormData = jest.fn(() => ({
      append: jest.fn(),
    })) as any;
    global.Blob = jest.fn() as any;

    const config: ASRConfig = {
      apiKey: mockApiKey,
      model: 'whisper-1',
      language: 'en',
      sampleRate: 16000,
    };

    asrService = new ASRService(config);
  });

  afterEach(() => {
    asrService.stop();
    jest.useRealTimers();
  });

  describe('Constructor', () => {
    it('should initialize with provided config', () => {
      expect(asrService).toBeInstanceOf(ASRService);
    });

    it('should use default values for optional config', () => {
      const minimalConfig: ASRConfig = {
        apiKey: mockApiKey,
      };
      const service = new ASRService(minimalConfig);
      expect(service).toBeInstanceOf(ASRService);
    });
  });

  describe('start() and stop()', () => {
    it('should start processing interval', () => {
      asrService.start();
      expect(asrService['processingInterval']).not.toBeNull();
    });

    it('should stop processing interval', () => {
      asrService.start();
      asrService.stop();
      expect(asrService['processingInterval']).toBeNull();
    });

    it('should handle multiple stop calls gracefully', () => {
      asrService.start();
      expect(() => {
        asrService.stop();
        asrService.stop();
        asrService.stop();
      }).not.toThrow();
    });
  });

  describe('pushAudio()', () => {
    it('should add audio chunk to buffer', () => {
      const chunk = Buffer.alloc(1000);
      asrService.pushAudio(chunk);
      expect(asrService['audioBuffer'].length).toBe(1);
    });

    it('should accumulate multiple audio chunks', () => {
      const chunk1 = Buffer.alloc(1000);
      const chunk2 = Buffer.alloc(2000);
      const chunk3 = Buffer.alloc(1500);

      asrService.pushAudio(chunk1);
      asrService.pushAudio(chunk2);
      asrService.pushAudio(chunk3);

      expect(asrService['audioBuffer'].length).toBe(3);
    });
  });

  describe('processAudioBuffer()', () => {
    it('should skip processing if buffer is empty', async () => {
      await asrService['processAudioBuffer']();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should skip processing if already processing', async () => {
      asrService['isProcessing'] = true;
      asrService.pushAudio(Buffer.alloc(20000));

      await asrService['processAudioBuffer']();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should skip processing if audio is too short', async () => {
      const shortAudio = Buffer.alloc(100);
      asrService.pushAudio(shortAudio);

      await asrService['processAudioBuffer']();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should process audio buffer when sufficient data available', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ text: 'Hello world' }),
      });

      const audioData = Buffer.alloc(20000);
      asrService.pushAudio(audioData);

      await asrService['processAudioBuffer']();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/audio/transcriptions',
        expect.objectContaining({
          method: 'POST',
          headers: {
            Authorization: `Bearer ${mockApiKey}`,
          },
        })
      );
    });

    it('should emit transcript event on successful transcription', async () => {
      const transcriptListener = jest.fn();
      asrService.on('transcript', transcriptListener);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ text: 'Hello world' }),
      });

      const audioData = Buffer.alloc(20000);
      asrService.pushAudio(audioData);

      await asrService['processAudioBuffer']();

      expect(transcriptListener).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'Hello world',
          isFinal: true,
          timestamp: expect.any(Date),
        })
      );
    });

    it('should not emit transcript for empty text', async () => {
      const transcriptListener = jest.fn();
      asrService.on('transcript', transcriptListener);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ text: '   ' }),
      });

      const audioData = Buffer.alloc(20000);
      asrService.pushAudio(audioData);

      await asrService['processAudioBuffer']();

      expect(transcriptListener).not.toHaveBeenCalled();
    });

    it('should emit error event on processing failure', async () => {
      const errorListener = jest.fn();
      asrService.on('error', errorListener);

      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const audioData = Buffer.alloc(20000);
      asrService.pushAudio(audioData);

      await asrService['processAudioBuffer']();

      expect(errorListener).toHaveBeenCalled();
    });

    it('should clear buffer after processing', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ text: 'Test' }),
      });

      const audioData = Buffer.alloc(20000);
      asrService.pushAudio(audioData);
      asrService.pushAudio(audioData);

      expect(asrService['audioBuffer'].length).toBe(2);

      await asrService['processAudioBuffer']();

      expect(asrService['audioBuffer'].length).toBe(0);
    });
  });

  describe('transcribe()', () => {
    it('should call Whisper API with correct parameters', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ text: 'Transcription result' }),
      });

      const audioData = Buffer.alloc(20000);
      const result = await asrService['transcribe'](audioData);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/audio/transcriptions',
        expect.objectContaining({
          method: 'POST',
          headers: {
            Authorization: `Bearer ${mockApiKey}`,
          },
        })
      );

      expect(result).toEqual({
        text: 'Transcription result',
        isFinal: true,
        timestamp: expect.any(Date),
      });
    });

    it('should return null on API error', async () => {
      const errorListener = jest.fn();
      asrService.on('error', errorListener);

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'Bad request',
      });

      const audioData = Buffer.alloc(20000);
      const result = await asrService['transcribe'](audioData);

      expect(result).toBeNull();
      expect(errorListener).toHaveBeenCalled();
    });

    it('should emit error event on transcription failure', async () => {
      const errorListener = jest.fn();
      asrService.on('error', errorListener);

      // Mock 400 error (non-retryable)
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'Bad request',
      });

      const audioData = Buffer.alloc(20000);
      const result = await asrService['transcribe'](audioData);

      expect(result).toBeNull();
      expect(errorListener).toHaveBeenCalled();
    });

    it('should handle network errors gracefully', async () => {
      const errorListener = jest.fn();
      asrService.on('error', errorListener);

      // Mock single network failure (no retry for Error type)
      mockFetch.mockRejectedValueOnce(new Error('Network failure'));

      const audioData = Buffer.alloc(20000);
      const result = await asrService['transcribe'](audioData);

      expect(result).toBeNull();
      expect(errorListener).toHaveBeenCalled();
    });
  });

  describe('pcmToWav()', () => {
    it('should convert PCM data to WAV format', () => {
      const pcmData = Buffer.alloc(1000);
      const wavBuffer = asrService['pcmToWav'](pcmData);

      // WAV header is 44 bytes
      expect(wavBuffer.length).toBe(44 + 1000);

      // Check RIFF header
      expect(wavBuffer.toString('utf8', 0, 4)).toBe('RIFF');
      expect(wavBuffer.toString('utf8', 8, 12)).toBe('WAVE');

      // Check fmt chunk
      expect(wavBuffer.toString('utf8', 12, 16)).toBe('fmt ');

      // Check data chunk
      expect(wavBuffer.toString('utf8', 36, 40)).toBe('data');
    });

    it('should set correct sample rate in WAV header', () => {
      const pcmData = Buffer.alloc(1000);
      const wavBuffer = asrService['pcmToWav'](pcmData);

      // Sample rate is at byte 24-27 (little endian)
      const sampleRate = wavBuffer.readUInt32LE(24);
      expect(sampleRate).toBe(16000);
    });

    it('should set correct number of channels', () => {
      const pcmData = Buffer.alloc(1000);
      const wavBuffer = asrService['pcmToWav'](pcmData);

      // Num channels is at byte 22-23 (little endian)
      const numChannels = wavBuffer.readUInt16LE(22);
      expect(numChannels).toBe(1);
    });

    it('should set correct bits per sample', () => {
      const pcmData = Buffer.alloc(1000);
      const wavBuffer = asrService['pcmToWav'](pcmData);

      // Bits per sample is at byte 34-35 (little endian)
      const bitsPerSample = wavBuffer.readUInt16LE(34);
      expect(bitsPerSample).toBe(16);
    });

    it('should handle empty PCM data', () => {
      const pcmData = Buffer.alloc(0);
      const wavBuffer = asrService['pcmToWav'](pcmData);

      expect(wavBuffer.length).toBe(44);
    });
  });

  describe('Periodic Processing', () => {
    it('should process buffer at regular intervals when started', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ text: 'Test' }),
      });

      const audioData = Buffer.alloc(20000);
      asrService.pushAudio(audioData);

      asrService.start();

      // Fast-forward 500ms
      jest.advanceTimersByTime(500);
      await Promise.resolve();

      expect(mockFetch).toHaveBeenCalled();
    });

    it('should not process when stopped', () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ text: 'Test' }),
      });

      const audioData = Buffer.alloc(20000);
      asrService.pushAudio(audioData);

      asrService.start();
      asrService.stop();

      mockFetch.mockClear();

      // Fast-forward 500ms
      jest.advanceTimersByTime(500);

      // Interval should not be running anymore
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('Event Emitter', () => {
    it('should allow registering multiple transcript listeners', async () => {
      const listener1 = jest.fn();
      const listener2 = jest.fn();

      asrService.on('transcript', listener1);
      asrService.on('transcript', listener2);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ text: 'Hello' }),
      });

      const audioData = Buffer.alloc(20000);
      asrService.pushAudio(audioData);
      await asrService['processAudioBuffer']();

      expect(listener1).toHaveBeenCalled();
      expect(listener2).toHaveBeenCalled();
    });

    it('should allow removing event listeners', async () => {
      const listener = jest.fn();

      asrService.on('transcript', listener);
      asrService.off('transcript', listener);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ text: 'Hello' }),
      });

      const audioData = Buffer.alloc(20000);
      asrService.pushAudio(audioData);
      await asrService['processAudioBuffer']();

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('Integration Scenarios', () => {
    it('should handle full audio processing pipeline', async () => {
      const transcripts: TranscriptResult[] = [];
      asrService.on('transcript', (transcript: TranscriptResult) => {
        transcripts.push(transcript);
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ text: 'First utterance' }),
      });

      // Push multiple chunks
      asrService.pushAudio(Buffer.alloc(10000));
      asrService.pushAudio(Buffer.alloc(10000));
      asrService.pushAudio(Buffer.alloc(5000));

      await asrService['processAudioBuffer']();

      expect(transcripts.length).toBe(1);
      expect(transcripts[0].text).toBe('First utterance');
      expect(transcripts[0].isFinal).toBe(true);
    });

    it('should recover from temporary API failures', async () => {
      const transcripts: TranscriptResult[] = [];
      const errors: Error[] = [];

      asrService.on('transcript', (transcript: TranscriptResult) => {
        transcripts.push(transcript);
      });

      asrService.on('error', (error: Error) => {
        errors.push(error);
      });

      // First call fails (non-retryable 400 error)
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'Bad request',
      });

      asrService.pushAudio(Buffer.alloc(20000));
      await asrService['processAudioBuffer']();

      expect(transcripts.length).toBe(0);
      expect(errors.length).toBeGreaterThan(0);

      // Second call succeeds
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ text: 'Success after retry' }),
      });

      asrService.pushAudio(Buffer.alloc(20000));
      await asrService['processAudioBuffer']();

      expect(transcripts.length).toBe(1);
      expect(transcripts[0].text).toBe('Success after retry');
    });
  });
});
