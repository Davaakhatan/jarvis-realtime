import { z } from 'zod';

export const MessageRoleSchema = z.enum(['user', 'assistant', 'system']);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

export const CitationSchema = z.object({
  source: z.string(),
  url: z.string().optional(),
  snippet: z.string(),
  timestamp: z.date(),
});
export type Citation = z.infer<typeof CitationSchema>;

export const MessageSchema = z.object({
  id: z.string().uuid(),
  role: MessageRoleSchema,
  content: z.string(),
  citations: z.array(CitationSchema).optional(),
  timestamp: z.date(),
  audioUrl: z.string().optional(),
});
export type Message = z.infer<typeof MessageSchema>;

export const ConversationSchema = z.object({
  id: z.string().uuid(),
  userId: z.string(),
  messages: z.array(MessageSchema),
  createdAt: z.date(),
  updatedAt: z.date(),
  metadata: z.record(z.unknown()).optional(),
});
export type Conversation = z.infer<typeof ConversationSchema>;

export const SessionStateSchema = z.enum([
  'idle',
  'listening',
  'processing',
  'speaking',
  'interrupted',
]);
export type SessionState = z.infer<typeof SessionStateSchema>;

export const SessionSchema = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  state: SessionStateSchema,
  startedAt: z.date(),
  lastActivityAt: z.date(),
});
export type Session = z.infer<typeof SessionSchema>;
