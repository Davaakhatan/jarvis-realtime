import { EventEmitter } from 'events';
import { createChildLogger } from '../../shared/utils/index';
import { Message, Citation } from '../../shared/types/index';
import {
  withRetry,
  RetryableError,
  withTimeout,
  RateLimiter,
  CircuitBreaker,
} from '../../shared/utils/retry';

const logger = createChildLogger('llm-service');

export interface LLMConfig {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
  citations?: Citation[];
  finishReason: 'stop' | 'tool_calls' | 'length';
}

export class LLMService extends EventEmitter {
  private config: LLMConfig;
  private tools: ToolDefinition[] = [];
  private systemPrompt: string;
  private rateLimiter: RateLimiter;
  private circuitBreaker: CircuitBreaker;

  constructor(config: LLMConfig) {
    super();
    this.config = {
      model: 'gpt-4o-mini',
      maxTokens: 1024,
      temperature: 0.3, // Lower temperature for more factual, consistent responses
      ...config,
    };

    // Rate limit: 10,000 tokens per minute (approximately 50 requests/min for 200 token responses)
    this.rateLimiter = new RateLimiter(50, 60000, 10);

    // Circuit breaker: open after 5 failures, reset after 30 seconds
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: 5,
      resetTimeoutMs: 30000,
    });

    this.systemPrompt = `You are Jarvis, a real-time voice assistant for frontline workers in high-stakes environments.

ZERO HALLUCINATION PROTOCOL - THESE RULES ARE ABSOLUTE:

1. ONLY state facts that are DIRECTLY present in the provided context data.
2. If information is NOT in the context, say: "I don't have that information in my current data."
3. NEVER invent statistics, numbers, dates, names, or details that aren't explicitly provided.
4. When uncertain, ALWAYS err on the side of admitting uncertainty rather than guessing.
5. Distinguish clearly between:
   - VERIFIED: Information directly from context/API data
   - INFERRED: Logical conclusions from verified data (state this explicitly)
   - UNKNOWN: Information not available (admit this directly)

RESPONSE FORMAT:
- Keep responses concise (2-3 sentences max for voice)
- Start with the most critical information
- Cite sources inline: "According to [source]..."
- If you cannot verify a claim, prefix with "I cannot verify this, but..."

TOOLS AVAILABLE:
- GitHub search for code and documentation
- API data (refreshes every 3 minutes)
- Conversation history for context

WHEN TO SAY "I DON'T KNOW":
- The question asks about data not in your context
- You would need to make assumptions to answer
- The information might be outdated or incomplete

Your primary goal is ACCURACY over helpfulness. A confident wrong answer is worse than admitting uncertainty.`;
  }

  registerTool(tool: ToolDefinition): void {
    this.tools.push(tool);
    logger.info({ toolName: tool.name }, 'Tool registered');
  }

  async chat(
    messages: Message[],
    context?: Record<string, unknown>
  ): Promise<LLMResponse> {
    const startTime = Date.now();

    try {
      // Apply rate limiting
      await this.rateLimiter.acquire();

      const formattedMessages = [
        { role: 'system', content: this.buildSystemPrompt(context) },
        ...messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      ];

      const requestBody: Record<string, unknown> = {
        model: this.config.model,
        messages: formattedMessages,
        max_tokens: this.config.maxTokens,
        temperature: this.config.temperature,
      };

      if (this.tools.length > 0) {
        requestBody.tools = this.tools.map((t) => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          },
        }));
      }

      // Use circuit breaker and retry logic
      const result = await this.circuitBreaker.execute(() =>
        withRetry(
          async () => {
            const response = await withTimeout(
              fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${this.config.apiKey}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestBody),
              }),
              60000 // 60 second timeout for LLM
            );

            if (!response.ok) {
              const error = await response.text();
              // Retry on 5xx errors and rate limits
              if (response.status >= 500 || response.status === 429) {
                throw new RetryableError(`LLM API error: ${error}`);
              }
              throw new Error(`LLM API error: ${error}`);
            }

            return (await response.json()) as {
              choices: Array<{
                message: {
                  content: string | null;
                  tool_calls?: Array<{
                    id: string;
                    function: { name: string; arguments: string };
                  }>;
                };
                finish_reason: string;
              }>;
            };
          },
          {
            maxAttempts: 3,
            initialDelayMs: 2000,
            maxDelayMs: 10000,
            retryableErrors: [RetryableError],
            onRetry: (error, attempt) => {
              logger.warn(
                { error: error.message, attempt },
                'Retrying LLM request'
              );
            },
          }
        )
      );

      const choice = result.choices[0];
      const toolCalls = choice.message.tool_calls?.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments),
      }));

      const duration = Date.now() - startTime;
      logger.debug({ duration, hasToolCalls: !!toolCalls }, 'LLM response received');

      return {
        content: choice.message.content || '',
        toolCalls,
        finishReason: choice.finish_reason as LLMResponse['finishReason'],
      };
    } catch (error) {
      logger.error({ error }, 'LLM chat failed after retries');
      throw error;
    }
  }

  async *chatStream(
    messages: Message[],
    context?: Record<string, unknown>
  ): AsyncGenerator<string> {
    try {
      const formattedMessages = [
        { role: 'system', content: this.buildSystemPrompt(context) },
        ...messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      ];

      const response = await fetch(
        'https://api.openai.com/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: this.config.model,
            messages: formattedMessages,
            max_tokens: this.config.maxTokens,
            temperature: this.config.temperature,
            stream: true,
          }),
        }
      );

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`LLM API error: ${error}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;

            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices?.[0]?.delta?.content;
              if (content) {
                yield content;
              }
            } catch {
              // Skip invalid JSON
            }
          }
        }
      }
    } catch (error) {
      logger.error({ error }, 'LLM stream failed');
      throw error;
    }
  }

  private buildSystemPrompt(context?: Record<string, unknown>): string {
    let prompt = this.systemPrompt;

    if (context) {
      prompt += '\n\n--- CURRENT CONTEXT ---\n';
      prompt += JSON.stringify(context, null, 2);
    }

    return prompt;
  }
}
