# Active Context

## Current Focus

- Project scaffold complete and pushed to GitHub
- Continuing development of core services
- Next: ASR, TTS, and LLM integrations

## Recent Decisions

- TypeScript for orchestrator with Express + WebSocket
- Python FastAPI for AI/ML services (verification, vector-store)
- Zod for runtime type validation
- Pino for structured logging
- Docker Compose for local development stack

## Project Metadata

- **Organization:** Frontier Audio
- **Project ID:** VyuiwBOFxfoySBVh4b7D_1762227805787
- **Repository:** https://github.com/Davaakhatan/jarvis-realtime.git

## Active Development

### Completed This Session

1. Project structure initialized
2. TypeScript orchestrator with WebSocket real-time support
3. Session management and pipeline architecture
4. Python verification and vector-store services
5. Docker and CI/CD configuration
6. Initial commit pushed to GitHub

### In Progress

1. ASR service integration (speech-to-text)
2. TTS service integration (text-to-speech)
3. LLM integration with tool-use capabilities

### Next Steps

1. Add ASR client in orchestrator to connect to speech recognition
2. Add TTS client for response audio synthesis
3. Integrate LLM with streaming responses
4. Implement GitHub integration for knowledge retrieval
5. Build API poller for data freshness

## Open Questions

- Which ASR vendor to use? (Whisper, Deepgram, AssemblyAI)
- Which TTS vendor? (ElevenLabs, OpenAI, AWS Polly)
- LLM choice for tool-use? (GPT-4, Claude, open-source)
