## System Patterns

### Architecture
- **Edge capture layer** streams microphone input, performs wake-word detection, and forwards PCM chunks.
- **Streaming ASR service** (Python/TS wrapper over vendor model) outputs partial transcripts to an LLM router.
- **Dialogue orchestrator** maintains conversation memory, enforces zero-hallucination policy via tool grounding, and handles interrupt signals.
- **Tooling layer**: API pollers (3‑minute cadence), GitHub search + summarization, and verification pipelines.
- **Response renderer** returns synthesized speech plus concise textual confirmations for mission logs.

### Key Patterns
- Event-driven pipeline with back-pressure control to guarantee <500 ms latency.
- Strict grounding: every LLM answer must cite a verified data source (API snapshot, GitHub doc, or cached task record).
- Interrupt-first UX: speech input or hardware button can cancel any downstream chain.
- Observability hooks on every stage (latency, accuracy, clarity) feeding into compliance dashboards.

### Security & Compliance
- End-to-end encrypted transport (WebRTC/DTLS for audio, TLS 1.3 for APIs).
- Access tokens scoped per integration with automated rotation.
- Audit logging for every request/response pair to support GDPR and incident reviews.

