import { z } from 'zod';
import { SessionStateSchema } from './conversation';

export const EventTypeSchema = z.enum([
  'audio.chunk',
  'audio.end',
  'transcript.partial',
  'transcript.final',
  'llm.start',
  'llm.chunk',
  'llm.end',
  'tts.start',
  'tts.chunk',
  'tts.end',
  'session.state_change',
  'session.interrupt',
  'error',
]);
export type EventType = z.infer<typeof EventTypeSchema>;

export const BaseEventSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  type: EventTypeSchema,
  timestamp: z.date(),
});

export const AudioChunkEventSchema = BaseEventSchema.extend({
  type: z.literal('audio.chunk'),
  payload: z.object({
    data: z.instanceof(Buffer),
    sampleRate: z.number(),
    channels: z.number(),
  }),
});
export type AudioChunkEvent = z.infer<typeof AudioChunkEventSchema>;

export const AudioEndEventSchema = BaseEventSchema.extend({
  type: z.literal('audio.end'),
  payload: z.object({}),
});
export type AudioEndEvent = z.infer<typeof AudioEndEventSchema>;

export const TranscriptEventSchema = BaseEventSchema.extend({
  type: z.enum(['transcript.partial', 'transcript.final']),
  payload: z.object({
    text: z.string(),
    confidence: z.number().min(0).max(1).optional(),
    isFinal: z.boolean(),
  }),
});
export type TranscriptEvent = z.infer<typeof TranscriptEventSchema>;

export const LLMEventSchema = BaseEventSchema.extend({
  type: z.enum(['llm.start', 'llm.chunk', 'llm.end']),
  payload: z.object({
    text: z.string().optional(),
    toolCall: z.object({
      name: z.string(),
      arguments: z.record(z.unknown()),
    }).optional(),
  }),
});
export type LLMEvent = z.infer<typeof LLMEventSchema>;

export const TTSEventSchema = BaseEventSchema.extend({
  type: z.enum(['tts.start', 'tts.chunk', 'tts.end']),
  payload: z.object({
    audio: z.instanceof(Buffer).optional(),
  }),
});
export type TTSEvent = z.infer<typeof TTSEventSchema>;

export const StateChangeEventSchema = BaseEventSchema.extend({
  type: z.literal('session.state_change'),
  payload: z.object({
    previousState: SessionStateSchema,
    newState: SessionStateSchema,
  }),
});
export type StateChangeEvent = z.infer<typeof StateChangeEventSchema>;

export const InterruptEventSchema = BaseEventSchema.extend({
  type: z.literal('session.interrupt'),
  payload: z.object({
    reason: z.enum(['user', 'timeout', 'error']),
  }),
});
export type InterruptEvent = z.infer<typeof InterruptEventSchema>;

export const ErrorEventSchema = BaseEventSchema.extend({
  type: z.literal('error'),
  payload: z.object({
    code: z.string(),
    message: z.string(),
    recoverable: z.boolean(),
  }),
});
export type ErrorEvent = z.infer<typeof ErrorEventSchema>;

export type PipelineEvent =
  | AudioChunkEvent
  | AudioEndEvent
  | TranscriptEvent
  | LLMEvent
  | TTSEvent
  | StateChangeEvent
  | InterruptEvent
  | ErrorEvent;
