import { EventEmitter } from 'events';
import { createChildLogger } from '../../shared/utils/index.js';
import { Message, Citation } from '../../shared/types/index.js';

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

  constructor(config: LLMConfig) {
    super();
    this.config = {
      model: 'gpt-4-turbo-preview',
      maxTokens: 1024,
      temperature: 0.7,
      ...config,
    };

    this.systemPrompt = `You are Jarvis, a real-time voice assistant for frontline workers.

CRITICAL RULES:
1. NEVER hallucinate or make up information. Only provide facts you can verify from provided context.
2. If you don't know something or can't verify it, say "I don't have verified information about that."
3. Keep responses concise and actionable - users need quick answers.
4. Always cite your sources when providing information.
5. If asked about something outside your knowledge, offer to search or look it up.

You have access to tools for:
- Searching GitHub repositories for documentation and code
- Querying API data that refreshes every 3 minutes
- Accessing conversation history for context

Be helpful, accurate, and efficient.`;
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

      const response = await fetch(
        'https://api.openai.com/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        }
      );

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`LLM API error: ${error}`);
      }

      const result = (await response.json()) as {
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
      logger.error({ error }, 'LLM chat failed');
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
