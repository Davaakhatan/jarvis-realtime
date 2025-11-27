import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const ConfigSchema = z.object({
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
  port: z.coerce.number().default(3000),
  wsPort: z.coerce.number().default(3001),

  // Redis
  redisUrl: z.string().default('redis://localhost:6379'),

  // ASR Service
  asrServiceUrl: z.string().default('http://localhost:8001'),

  // TTS Service
  ttsServiceUrl: z.string().default('http://localhost:8002'),

  // LLM
  llmApiKey: z.string().optional(),
  llmModel: z.string().default('gpt-4'),

  // GitHub Integration
  githubToken: z.string().optional(),

  // API Poller
  apiRefreshIntervalMs: z.coerce.number().default(180000), // 3 minutes

  // Performance
  maxLatencyMs: z.coerce.number().default(500),

  // Session
  sessionTimeoutMs: z.coerce.number().default(300000), // 5 minutes
});

export type Config = z.infer<typeof ConfigSchema>;

const parseConfig = (): Config => {
  const result = ConfigSchema.safeParse({
    nodeEnv: process.env.NODE_ENV,
    port: process.env.PORT,
    wsPort: process.env.WS_PORT,
    redisUrl: process.env.REDIS_URL,
    asrServiceUrl: process.env.ASR_SERVICE_URL,
    ttsServiceUrl: process.env.TTS_SERVICE_URL,
    llmApiKey: process.env.LLM_API_KEY,
    llmModel: process.env.LLM_MODEL,
    githubToken: process.env.GITHUB_TOKEN,
    apiRefreshIntervalMs: process.env.API_REFRESH_INTERVAL_MS,
    maxLatencyMs: process.env.MAX_LATENCY_MS,
    sessionTimeoutMs: process.env.SESSION_TIMEOUT_MS,
  });

  if (!result.success) {
    console.error('Invalid configuration:', result.error.format());
    process.exit(1);
  }

  return result.data;
};

export const config = parseConfig();
