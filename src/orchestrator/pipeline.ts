import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { PipelineEvent, Message } from '../shared/types/index';
import { createChildLogger, config } from '../shared/utils/index';
import { SessionManager } from './session-manager';
import { ASRService, TranscriptResult } from '../services/asr/index';
import { TTSService } from '../services/tts/index';
import { LLMService, ToolCall } from '../services/llm/index';
import { GitHubService, githubTools } from '../services/github-integration/index';
import { APIPoller, apiPollerTools } from '../services/api-poller/index';
import { VerificationClient } from '../services/verification/index';
import { VectorStoreClient } from '../services/vector-store/index';
import { WakeWordService, WakeWordDetection } from '../services/wake-word/index';

const logger = createChildLogger('pipeline');

export interface PipelineOptions {
  maxLatencyMs: number;
  openaiApiKey: string;
  githubToken?: string;
  verificationEnabled?: boolean;
}

export interface PipelineServices {
  asr: ASRService;
  tts: TTSService;
  llm: LLMService;
  github?: GitHubService;
  apiPoller: APIPoller;
  verification: VerificationClient;
  vectorStore: VectorStoreClient;
  wakeWord: WakeWordService;
}

export class Pipeline extends EventEmitter {
  private sessionManager: SessionManager;
  private options: PipelineOptions;
  private services: PipelineServices;
  private processingTimers: Map<string, number> = new Map();
  private conversationHistory: Map<string, Message[]> = new Map();
  private audioBuffers: Map<string, Buffer[]> = new Map();
  private activeResponseIds: Map<string, string> = new Map(); // Track active response per session

  constructor(
    sessionManager: SessionManager,
    options: PipelineOptions
  ) {
    super();
    this.sessionManager = sessionManager;
    this.options = options;

    // Initialize services
    this.services = this.initializeServices();
    this.setupServiceListeners();
  }

  private initializeServices(): PipelineServices {
    const asr = new ASRService({
      apiKey: this.options.openaiApiKey,
    });

    const tts = new TTSService({
      apiKey: this.options.openaiApiKey,
      voice: 'nova',
    });

    const llm = new LLMService({
      apiKey: this.options.openaiApiKey,
      model: 'gpt-4-turbo-preview',
    });

    // Register tools with LLM
    for (const tool of [...githubTools, ...apiPollerTools]) {
      llm.registerTool(tool);
    }

    const apiPoller = new APIPoller({
      defaultIntervalMs: 180000, // 3 minutes
    });

    let github: GitHubService | undefined;
    if (this.options.githubToken) {
      github = new GitHubService({
        token: this.options.githubToken,
      });
    }

    const verification = new VerificationClient({
      serviceUrl: config.verificationServiceUrl || 'http://localhost:8003',
      enabled: this.options.verificationEnabled ?? true,
      useBuiltInEngine: true,
      apiKey: this.options.openaiApiKey,
      useLLMVerification: false, // Use rule-based for low latency
    });

    const vectorStore = new VectorStoreClient({
      serviceUrl: config.vectorStoreServiceUrl || 'http://localhost:8004',
      enabled: false, // Disabled - vector store service not running
    });

    const wakeWord = new WakeWordService({
      wakeWords: ['jarvis', 'hey jarvis', 'ok jarvis'],
      interruptWords: ['stop', 'cancel', 'wait', 'hold on', 'pause', 'never mind'],
      sensitivity: 0.7,
      debounceMs: 1000,
    });

    return { asr, tts, llm, github, apiPoller, verification, vectorStore, wakeWord };
  }

  private setupServiceListeners(): void {
    this.services.asr.on('transcript', (result: TranscriptResult) => {
      // Handle transcription results
      logger.debug({ text: result.text }, 'Received transcript');
    });

    this.services.asr.on('error', (error: Error) => {
      logger.error({ error }, 'ASR error');
    });

    this.services.apiPoller.on('data', ({ endpointId }: { endpointId: string }) => {
      logger.debug({ endpointId }, 'API data refreshed');
    });

    // Listen for wake word events
    this.services.wakeWord.on('wake', (detection: WakeWordDetection) => {
      logger.info({ word: detection.word }, 'Wake word detected');
      this.emit('wakeWordDetected', detection);
    });

    // Listen for interrupt word events
    this.services.wakeWord.on('interrupt', (detection: WakeWordDetection) => {
      logger.info({ word: detection.word }, 'Interrupt word detected');
      this.emit('interruptDetected', detection);
    });
  }

  private isSessionInterrupted(sessionId: string): boolean {
    const session = this.sessionManager.getSession(sessionId);
    return !session || session.state === 'interrupted';
  }

  start(): void {
    this.services.apiPoller.startAllPolling();
    logger.info('Pipeline started');
  }

  stop(): void {
    this.services.apiPoller.stopAllPolling();
    logger.info('Pipeline stopped');
  }

  async processAudioChunk(sessionId: string, audioData: Buffer): Promise<void> {
    const startTime = Date.now();
    this.processingTimers.set(sessionId, startTime);

    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      logger.warn({ sessionId }, 'No session found for audio processing');
      return;
    }

    if (session.state === 'interrupted') {
      logger.debug({ sessionId }, 'Skipping audio processing - session interrupted');
      return;
    }

    this.sessionManager.updateSessionState(sessionId, 'listening');

    // Store audio in per-session buffer
    if (!this.audioBuffers.has(sessionId)) {
      this.audioBuffers.set(sessionId, []);
    }
    this.audioBuffers.get(sessionId)!.push(audioData);

    this.emit('event', {
      id: uuidv4(),
      sessionId,
      type: 'audio.chunk',
      timestamp: new Date(),
      payload: {
        data: audioData,
        sampleRate: 16000,
        channels: 1,
      },
    } as PipelineEvent);
  }

  async processAudioEnd(sessionId: string): Promise<void> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      logger.warn({ sessionId }, 'No session found for audio end processing');
      return;
    }

    const audioChunks = this.audioBuffers.get(sessionId) || [];
    if (audioChunks.length === 0) {
      logger.debug({ sessionId }, 'No audio data to process');
      return;
    }

    // Combine all audio chunks
    const audioData = Buffer.concat(audioChunks);
    this.audioBuffers.delete(sessionId);

    // Skip if audio is too short (less than 0.5 seconds at 16kHz, 16-bit)
    if (audioData.length < 16000) {
      logger.debug({ sessionId, length: audioData.length }, 'Audio too short, skipping');
      this.sessionManager.updateSessionState(sessionId, 'idle');
      return;
    }

    logger.debug({ sessionId, audioLength: audioData.length }, 'Processing audio');
    this.sessionManager.updateSessionState(sessionId, 'processing');

    this.emit('event', {
      id: uuidv4(),
      sessionId,
      type: 'audio.end',
      timestamp: new Date(),
      payload: {},
    } as PipelineEvent);

    try {
      // Transcribe the audio using ASR service
      const transcript = await this.transcribeAudio(audioData);

      if (transcript && transcript.trim()) {
        logger.info({ sessionId, transcript }, 'Transcription result');
        await this.processTranscript(sessionId, transcript, true);
      } else {
        logger.debug({ sessionId }, 'No transcript from audio');
        this.sessionManager.updateSessionState(sessionId, 'idle');
      }
    } catch (error) {
      logger.error({ sessionId, error }, 'Audio transcription failed');
      this.sessionManager.updateSessionState(sessionId, 'idle');
    }
  }

  private async transcribeAudio(audioData: Buffer): Promise<string | null> {
    try {
      // Convert raw PCM to WAV format for Whisper API
      const wavBuffer = this.pcmToWav(audioData);

      // Use Node.js Blob from buffer module
      const { Blob } = await import('buffer');
      const audioBlob = new Blob([wavBuffer], { type: 'audio/wav' });

      const formData = new FormData();
      formData.append('file', audioBlob, 'audio.wav');
      formData.append('model', 'whisper-1');
      formData.append('language', 'en');
      formData.append('response_format', 'json');

      logger.debug({ apiKeyPresent: !!this.options.openaiApiKey, audioSize: wavBuffer.length }, 'Sending to Whisper API');

      const response = await fetch(
        'https://api.openai.com/v1/audio/transcriptions',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.options.openaiApiKey}`,
          },
          body: formData,
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Whisper API error (${response.status}): ${errorText}`);
      }

      const result = (await response.json()) as { text: string };
      return result.text;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ error: errorMessage, stack: error instanceof Error ? error.stack : undefined }, 'Transcription failed');
      return null;
    }
  }

  private pcmToWav(pcmData: Buffer): Buffer {
    const sampleRate = 16000;
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
    const blockAlign = (numChannels * bitsPerSample) / 8;
    const dataSize = pcmData.length;
    const headerSize = 44;
    const fileSize = headerSize + dataSize - 8;

    const header = Buffer.alloc(headerSize);

    // RIFF header
    header.write('RIFF', 0);
    header.writeUInt32LE(fileSize, 4);
    header.write('WAVE', 8);

    // fmt chunk
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); // fmt chunk size
    header.writeUInt16LE(1, 20); // audio format (PCM)
    header.writeUInt16LE(numChannels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);

    // data chunk
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    return Buffer.concat([header, pcmData]);
  }

  async processTranscript(
    sessionId: string,
    text: string,
    isFinal: boolean
  ): Promise<void> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return;
    }

    // Check for interrupt words while speaking
    if (session.state === 'speaking') {
      const detection = this.services.wakeWord.checkTranscript(text);
      if (detection?.type === 'interrupt') {
        logger.info({ sessionId, word: detection.word }, 'Interrupt detected while speaking');
        this.interrupt(sessionId);
        return;
      }
    }

    // If session is interrupted, check for wake word to resume
    if (session.state === 'interrupted') {
      const detection = this.services.wakeWord.checkTranscript(text);
      if (detection?.type === 'wake') {
        // Extract command after wake word and process it
        const command = this.services.wakeWord.extractCommandAfterWakeWord(text, detection.word);
        if (command) {
          this.sessionManager.updateSessionState(sessionId, 'processing');
          await this.processWithLLM(sessionId, command);
        }
      }
      return;
    }

    this.emit('event', {
      id: uuidv4(),
      sessionId,
      type: isFinal ? 'transcript.final' : 'transcript.partial',
      timestamp: new Date(),
      payload: {
        text,
        isFinal,
      },
    } as PipelineEvent);

    if (isFinal && text.trim()) {
      // Check for wake word at start of utterance
      const detection = this.services.wakeWord.checkTranscript(text);
      let processText = text;

      if (detection?.type === 'wake') {
        // Extract the actual command after wake word
        processText = this.services.wakeWord.extractCommandAfterWakeWord(text, detection.word);
        if (!processText) {
          // Wake word only, wait for next utterance
          return;
        }
      }

      this.sessionManager.updateSessionState(sessionId, 'processing');
      await this.processWithLLM(sessionId, processText);
    }
  }

  private async processWithLLM(sessionId: string, text: string): Promise<void> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session || session.state === 'interrupted') {
      return;
    }

    // Generate a unique response ID for this request
    const responseId = uuidv4();
    this.activeResponseIds.set(sessionId, responseId);

    // Get or create conversation history
    let history = this.conversationHistory.get(session.conversationId) || [];

    // Add user message
    const userMessage: Message = {
      id: uuidv4(),
      role: 'user',
      content: text,
      timestamp: new Date(),
    };
    history.push(userMessage);

    // Store user message in vector store for persistent memory
    this.storeMessageInVectorStore(session.conversationId, 'user', text).catch((err: Error) => {
      logger.error({ error: err }, 'Failed to store user message in vector store');
    });

    this.emit('event', {
      id: uuidv4(),
      sessionId,
      type: 'llm.start',
      timestamp: new Date(),
      payload: {},
    } as PipelineEvent);

    try {
      // Build context from API data
      const apiContext = this.services.apiPoller.getAllData();

      // Get LLM response with streaming
      let fullResponse = '';
      let sentenceBuffer = '';
      let isSpeaking = false;

      // Start speaking state as soon as we begin
      this.sessionManager.updateSessionState(sessionId, 'speaking');

      for await (const chunk of this.services.llm.chatStream(history, { apiData: apiContext })) {
        if (this.isSessionInterrupted(sessionId)) {
          logger.debug({ sessionId }, 'LLM processing interrupted');
          break;
        }

        fullResponse += chunk;
        sentenceBuffer += chunk;

        this.emit('event', {
          id: uuidv4(),
          sessionId,
          type: 'llm.chunk',
          timestamp: new Date(),
          payload: { text: chunk },
        } as PipelineEvent);

        // Check if we have a complete sentence (ends with . ! ? or newline)
        const sentenceMatch = sentenceBuffer.match(/^(.*?[.!?\n])\s*/);
        if (sentenceMatch) {
          const completeSentence = sentenceMatch[1].trim();
          sentenceBuffer = sentenceBuffer.slice(sentenceMatch[0].length);

          // Start TTS immediately for the first sentence
          if (completeSentence && !isSpeaking) {
            isSpeaking = true;
            this.emit('event', {
              id: uuidv4(),
              sessionId,
              type: 'tts.start',
              timestamp: new Date(),
              payload: {},
            } as PipelineEvent);
          }

          // Synthesize this sentence immediately
          if (completeSentence) {
            await this.streamSentenceToTTS(sessionId, responseId, completeSentence);
          }
        }
      }

      // Synthesize any remaining text in buffer
      if (!this.isSessionInterrupted(sessionId) && sentenceBuffer.trim()) {
        await this.streamSentenceToTTS(sessionId, responseId, sentenceBuffer.trim());
      }

      if (!this.isSessionInterrupted(sessionId) && fullResponse) {
        // Verify the response before proceeding
        let verifiedResponse = fullResponse;
        try {
          // Pass conversation history and API data for verification
          const conversationHistoryForVerification = history.map((m) => ({
            role: m.role,
            content: m.content,
          }));

          const verificationResult = await this.services.verification.verify({
            sessionId,
            responseText: fullResponse,
            claimedSources: [],
            context: {
              apiData: apiContext,
              conversationHistory: conversationHistoryForVerification,
            },
          });

          if (!verificationResult.verified) {
            logger.warn(
              { sessionId, confidence: verificationResult.confidence, warnings: verificationResult.warnings },
              'Response verification failed - using modified response'
            );
            // Use modified response with disclaimer if available
            if (verificationResult.modifiedResponse) {
              verifiedResponse = verificationResult.modifiedResponse;
            }
          }

          // Emit verification event
          this.emit('event', {
            id: uuidv4(),
            sessionId,
            type: 'llm.end',
            timestamp: new Date(),
            payload: {
              text: verifiedResponse,
              verification: {
                verified: verificationResult.verified,
                confidence: verificationResult.confidence,
                citations: verificationResult.citations,
              },
            },
          } as PipelineEvent);
        } catch (verifyError) {
          logger.error({ sessionId, error: verifyError }, 'Verification service error - proceeding without verification');
          this.emit('event', {
            id: uuidv4(),
            sessionId,
            type: 'llm.end',
            timestamp: new Date(),
            payload: { text: fullResponse },
          } as PipelineEvent);
        }

        // Add assistant message to history
        const assistantMessage: Message = {
          id: uuidv4(),
          role: 'assistant',
          content: verifiedResponse,
          timestamp: new Date(),
        };
        history.push(assistantMessage);
        this.conversationHistory.set(session.conversationId, history);

        // Store messages in vector store for persistent memory
        this.storeMessageInVectorStore(session.conversationId, 'assistant', verifiedResponse).catch((err: Error) => {
          logger.error({ error: err }, 'Failed to store assistant message in vector store');
        });

        // Emit TTS end event if we started speaking
        if (isSpeaking) {
          this.emit('event', {
            id: uuidv4(),
            sessionId,
            type: 'tts.end',
            timestamp: new Date(),
            payload: {},
          } as PipelineEvent);
        }

        // Return to idle state
        this.sessionManager.updateSessionState(sessionId, 'idle');
      }
    } catch (error) {
      logger.error({ sessionId, error }, 'LLM processing failed');
      this.emit('event', {
        id: uuidv4(),
        sessionId,
        type: 'error',
        timestamp: new Date(),
        payload: {
          code: 'LLM_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
          recoverable: true,
        },
      } as PipelineEvent);
    }
  }

  private async streamSentenceToTTS(sessionId: string, responseId: string, text: string): Promise<void> {
    if (this.isSessionInterrupted(sessionId)) {
      return;
    }

    // Check if this response is still the active one (not superseded by a new request)
    if (this.activeResponseIds.get(sessionId) !== responseId) {
      logger.debug({ sessionId, responseId }, 'Skipping TTS for superseded response');
      return;
    }

    try {
      await this.services.tts.synthesizeStream(text, (chunk) => {
        // Check again inside callback - might have been superseded during TTS call
        if (this.isSessionInterrupted(sessionId) || this.activeResponseIds.get(sessionId) !== responseId) {
          return;
        }

        this.emit('event', {
          id: uuidv4(),
          sessionId,
          type: 'tts.chunk',
          timestamp: new Date(),
          payload: { audio: chunk },
        } as PipelineEvent);
      });
    } catch (error) {
      logger.error({ sessionId, error, text }, 'TTS sentence synthesis failed');
    }
  }

  private async synthesizeResponse(sessionId: string, text: string): Promise<void> {
    if (this.isSessionInterrupted(sessionId)) {
      return;
    }

    this.sessionManager.updateSessionState(sessionId, 'speaking');

    this.emit('event', {
      id: uuidv4(),
      sessionId,
      type: 'tts.start',
      timestamp: new Date(),
      payload: {},
    } as PipelineEvent);

    try {
      await this.services.tts.synthesizeStream(text, (chunk) => {
        if (this.isSessionInterrupted(sessionId)) {
          return;
        }

        this.emit('event', {
          id: uuidv4(),
          sessionId,
          type: 'tts.chunk',
          timestamp: new Date(),
          payload: { audio: chunk },
        } as PipelineEvent);
      });

      this.emit('event', {
        id: uuidv4(),
        sessionId,
        type: 'tts.end',
        timestamp: new Date(),
        payload: {},
      } as PipelineEvent);

      this.sessionManager.updateSessionState(sessionId, 'idle');
    } catch (error) {
      logger.error({ sessionId, error }, 'TTS synthesis failed');
      this.sessionManager.updateSessionState(sessionId, 'idle');
    }
  }

  async executeToolCall(sessionId: string, toolCall: ToolCall): Promise<unknown> {
    const { name, arguments: args } = toolCall;

    logger.debug({ sessionId, tool: name }, 'Executing tool call');

    switch (name) {
      case 'search_github_code':
        if (!this.services.github) {
          return { error: 'GitHub integration not configured' };
        }
        return this.services.github.searchCode(
          args.query as string,
          { repo: args.repo as string, language: args.language as string }
        );

      case 'get_github_file':
        if (!this.services.github) {
          return { error: 'GitHub integration not configured' };
        }
        return this.services.github.getFileContent(
          args.owner as string,
          args.repo as string,
          args.path as string
        );

      case 'search_github_issues':
        if (!this.services.github) {
          return { error: 'GitHub integration not configured' };
        }
        return this.services.github.searchIssues(
          args.query as string,
          { repo: args.repo as string, state: args.state as 'open' | 'closed' | 'all' }
        );

      case 'get_api_data':
        return this.services.apiPoller.getData(args.endpoint_id as string);

      case 'refresh_api_data':
        return this.services.apiPoller.forceRefresh(args.endpoint_id as string);

      case 'list_available_apis':
        return this.services.apiPoller.getAllData();

      default:
        return { error: `Unknown tool: ${name}` };
    }
  }

  interrupt(sessionId: string): void {
    const session = this.sessionManager.getSession(sessionId);
    const wasPlaying = session?.state === 'speaking';

    const interrupted = this.sessionManager.interrupt(sessionId);
    if (interrupted) {
      // If we were speaking, emit tts.stop first to tell client to stop audio immediately
      if (wasPlaying) {
        this.emit('event', {
          id: uuidv4(),
          sessionId,
          type: 'tts.stop',
          timestamp: new Date(),
          payload: {},
        } as unknown as PipelineEvent);
      }

      this.emit('event', {
        id: uuidv4(),
        sessionId,
        type: 'session.interrupt',
        timestamp: new Date(),
        payload: {
          reason: 'user',
        },
      } as PipelineEvent);
    }
  }

  checkLatency(sessionId: string): number | null {
    const startTime = this.processingTimers.get(sessionId);
    if (!startTime) return null;

    const latency = Date.now() - startTime;
    if (latency > this.options.maxLatencyMs) {
      logger.warn(
        { sessionId, latency, maxLatency: this.options.maxLatencyMs },
        'Latency exceeded threshold'
      );
    }
    return latency;
  }

  clearHistory(conversationId: string): void {
    this.conversationHistory.delete(conversationId);
    logger.debug({ conversationId }, 'Conversation history cleared');
  }

  private async storeMessageInVectorStore(
    conversationId: string,
    role: string,
    content: string
  ): Promise<void> {
    try {
      await this.services.vectorStore.storeMessage(conversationId, {
        role,
        content,
        timestamp: new Date().toISOString(),
      });
      logger.debug({ conversationId, role }, 'Message stored in vector store');
    } catch (error) {
      logger.error({ error, conversationId }, 'Failed to store message in vector store');
    }
  }

  async getRelevantContext(conversationId: string, query: string): Promise<string[]> {
    try {
      const context = await this.services.vectorStore.getConversationContext(
        conversationId,
        query,
        5
      );
      return context.context.map(c => `${c.role}: ${c.content}`);
    } catch (error) {
      logger.error({ error, conversationId }, 'Failed to get relevant context');
      return [];
    }
  }
}
