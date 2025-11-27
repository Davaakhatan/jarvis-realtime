## Tech Context

### Languages & Frameworks
| Layer | Technology | Purpose |
|-------|------------|---------|
| Backend Services | TypeScript (Node.js) | Real-time orchestration, API routing, dialogue management |
| AI/ML | Python | ASR integration, LLM bindings, verification tooling |
| Mobile (P2) | Kotlin | Android client |
| Mobile (P2) | Swift | iOS client |

### Infrastructure (AWS)
- **Compute**: ECS/Fargate or EKS for containerized microservices
- **Database**: Managed PostgreSQL (RDS) for relational data
- **Cache/Queue**: Redis for session management and message queues
- **Storage**: S3 for audio artifacts and backups
- **CDN/Streaming**: CloudFront + WebRTC for low-latency streaming edges
- **Secrets**: AWS KMS for encryption key management

### AI Stack
| Component | Purpose |
|-----------|---------|
| Streaming ASR | Vendor ASR (Whisper-RT or equivalent) for real-time transcription |
| LLM | Frontier-grade model with tool-use capabilities |
| Vector Store | PGVector or Pinecone for conversation memory and document retrieval |
| Safety Filters | Verification engine for hallucination prevention |
| TTS | Text-to-speech synthesis for response playback |

### Integrations
- **GitHub**: REST/GraphQL APIs for repository search, code snippets, issue summaries
- **Data APIs**: REST/GraphQL sources with 3-minute auto-refresh cycle
- **Webhooks**: Ingestion for critical real-time alerts
- **Private Repo**: GitHub with CI/CD skeleton and Infrastructure as Code

### Communication Protocols
| Protocol | Use Case |
|----------|----------|
| WebRTC/DTLS | Audio streaming from edge devices |
| gRPC | Low-latency service-to-service (ASR to Orchestrator) |
| WebSocket | Partial transcript streaming, real-time updates |
| REST/JSON | Control APIs, configuration management |

### Security & Compliance
- **Transport**: End-to-end encryption (WebRTC/DTLS for audio, TLS 1.3 for APIs)
- **Access Control**: IAM least-privilege policies
- **Secrets**: KMS-managed with automated rotation
- **Audit**: Comprehensive logging for all data access and modifications
- **Retention**: GDPR-compliant policies with automated deletion hooks
- **Authentication**: Per-integration access tokens with rotation

### Performance Requirements
- **Latency Budget**: ≤500 ms end-to-end (capture → ASR → LLM → TTS → playback)
- **Concurrency**: Support 10+ simultaneous user sessions (P2)
- **Availability**: Multi-AZ deployment for high availability
- **Disaster Recovery**: Snapshot backups for vector stores and databases
