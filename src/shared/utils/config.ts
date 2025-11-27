import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

// Load environment-specific .env files with precedence:
// 1. .env (default/shared)
// 2. .env.{NODE_ENV} (environment-specific)
// 3. .env.local (local overrides, never committed)
const nodeEnv = process.env.NODE_ENV || 'development';
const envFiles = [
  '.env',
  `.env.${nodeEnv}`,
  '.env.local'
];

// Load env files in order (later files override earlier ones)
envFiles.forEach(file => {
  const envPath = path.resolve(process.cwd(), file);
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: true });
  }
});

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

  // Verification Service
  verificationServiceUrl: z.string().default('http://localhost:8003'),
  verificationEnabled: z.coerce.boolean().default(true),

  // Vector Store Service
  vectorStoreServiceUrl: z.string().default('http://localhost:8004'),

  // Performance
  maxLatencyMs: z.coerce.number().default(500),

  // Session
  sessionTimeoutMs: z.coerce.number().default(300000), // 5 minutes

  // Logging
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
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
    llmApiKey: (process.env.LLM_API_KEY && process.env.LLM_API_KEY !== 'your-api-key-here')
      ? process.env.LLM_API_KEY
      : process.env.OPENAI_API_KEY,
    llmModel: process.env.LLM_MODEL,
    githubToken: process.env.GITHUB_TOKEN,
    apiRefreshIntervalMs: process.env.API_REFRESH_INTERVAL_MS,
    verificationServiceUrl: process.env.VERIFICATION_SERVICE_URL,
    verificationEnabled: process.env.VERIFICATION_ENABLED,
    vectorStoreServiceUrl: process.env.VECTOR_STORE_URL || process.env.VECTOR_STORE_SERVICE_URL,
    maxLatencyMs: process.env.MAX_LATENCY_MS,
    sessionTimeoutMs: process.env.SESSION_TIMEOUT_MS,
    logLevel: process.env.LOG_LEVEL,
  });

  if (!result.success) {
    console.error('Invalid configuration:', result.error.format());
    process.exit(1);
  }

  // Log which environment files were loaded (only in development)
  if (result.data.nodeEnv === 'development') {
    console.log(`Loaded configuration for ${result.data.nodeEnv} environment`);
    envFiles.forEach(file => {
      const envPath = path.resolve(process.cwd(), file);
      if (fs.existsSync(envPath)) {
        console.log(`  ✓ ${file}`);
      }
    });
  }

  return result.data;
};

export const config = parseConfig();

// Helper to check if we're in a specific environment
export const isDevelopment = config.nodeEnv === 'development';
export const isProduction = config.nodeEnv === 'production';
export const isTest = config.nodeEnv === 'test';
