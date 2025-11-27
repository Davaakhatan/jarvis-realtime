import { EventEmitter } from 'events';
import { createChildLogger } from '../../shared/utils/index';

const logger = createChildLogger('vector-store-client');

export interface VectorStoreClientOptions {
  serviceUrl: string;
  enabled?: boolean;
}

export interface Document {
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
  source: string;
  sourceUrl?: string;
}

export interface SearchQuery {
  query: string;
  topK?: number;
  filterMetadata?: Record<string, unknown>;
  conversationId?: string;
}

export interface SearchResult {
  id: string;
  content: string;
  score: number;
  metadata: Record<string, unknown>;
  source: string;
}

export interface SearchResponse {
  results: SearchResult[];
  query: string;
}

export interface MessageInput {
  role: string;
  content: string;
  timestamp?: string;
}

export interface ConversationContext {
  conversationId: string;
  context: Array<{
    role: string;
    content: string;
    timestamp: string | null;
    relevanceScore: number;
  }>;
  query: string | null;
}

interface StoreDocumentResponse {
  stored: boolean;
  id: string;
}

interface DeleteResponse {
  deleted: boolean;
  id?: string;
  conversation_id?: string;
}

interface StoreMessageResponse {
  stored: boolean;
  conversation_id?: string;
  count?: number;
}

interface HealthResponse {
  status: string;
  database: string;
}

interface ContextApiResponse {
  conversation_id: string;
  context: Array<{
    role: string;
    content: string;
    timestamp: string | null;
    relevance_score: number;
  }>;
  query: string | null;
}

export class VectorStoreClient extends EventEmitter {
  private serviceUrl: string;
  private enabled: boolean;

  constructor(options: VectorStoreClientOptions) {
    super();
    this.serviceUrl = options.serviceUrl.replace(/\/$/, '');
    this.enabled = options.enabled ?? true;
  }

  async storeDocument(document: Document): Promise<{ stored: boolean; id: string }> {
    if (!this.enabled) {
      logger.debug('Vector store disabled, skipping document storage');
      return { stored: false, id: document.id };
    }

    try {
      const response = await fetch(`${this.serviceUrl}/documents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: document.id,
          content: document.content,
          metadata: document.metadata || {},
          source: document.source,
          source_url: document.sourceUrl,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Failed to store document: ${error}`);
      }

      const result = (await response.json()) as StoreDocumentResponse;
      logger.debug({ documentId: document.id }, 'Document stored');
      return result;
    } catch (error) {
      logger.error({ error, documentId: document.id }, 'Failed to store document');
      throw error;
    }
  }

  async deleteDocument(documentId: string): Promise<{ deleted: boolean; id: string }> {
    if (!this.enabled) {
      return { deleted: false, id: documentId };
    }

    try {
      const response = await fetch(`${this.serviceUrl}/documents/${documentId}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Failed to delete document: ${error}`);
      }

      const result = (await response.json()) as DeleteResponse;
      return { deleted: result.deleted, id: documentId };
    } catch (error) {
      logger.error({ error, documentId }, 'Failed to delete document');
      throw error;
    }
  }

  async search(query: SearchQuery): Promise<SearchResponse> {
    if (!this.enabled) {
      return { results: [], query: query.query };
    }

    try {
      const response = await fetch(`${this.serviceUrl}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: query.query,
          top_k: query.topK ?? 5,
          filter_metadata: query.filterMetadata,
          conversation_id: query.conversationId,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Search failed: ${error}`);
      }

      const result = (await response.json()) as SearchResponse;
      logger.debug({ query: query.query, resultCount: result.results.length }, 'Search completed');
      return result;
    } catch (error) {
      logger.error({ error, query: query.query }, 'Search failed');
      throw error;
    }
  }

  async hybridSearch(query: SearchQuery): Promise<SearchResponse> {
    if (!this.enabled) {
      return { results: [], query: query.query };
    }

    try {
      const response = await fetch(`${this.serviceUrl}/search/hybrid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: query.query,
          top_k: query.topK ?? 5,
          filter_metadata: query.filterMetadata,
          conversation_id: query.conversationId,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Hybrid search failed: ${error}`);
      }

      return (await response.json()) as SearchResponse;
    } catch (error) {
      logger.error({ error, query: query.query }, 'Hybrid search failed');
      throw error;
    }
  }

  async storeMessage(conversationId: string, message: MessageInput): Promise<{ stored: boolean }> {
    if (!this.enabled) {
      return { stored: false };
    }

    try {
      const response = await fetch(`${this.serviceUrl}/conversations/${conversationId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Failed to store message: ${error}`);
      }

      const result = (await response.json()) as StoreMessageResponse;
      return { stored: result.stored };
    } catch (error) {
      logger.error({ error, conversationId }, 'Failed to store message');
      throw error;
    }
  }

  async storeConversationMemory(
    conversationId: string,
    messages: Array<{ role: string; content: string; timestamp?: string }>
  ): Promise<{ stored: boolean; count: number }> {
    if (!this.enabled) {
      return { stored: false, count: 0 };
    }

    try {
      const response = await fetch(`${this.serviceUrl}/conversations/${conversationId}/memory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: conversationId,
          messages,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Failed to store conversation memory: ${error}`);
      }

      const result = (await response.json()) as StoreMessageResponse;
      return { stored: result.stored, count: result.count ?? 0 };
    } catch (error) {
      logger.error({ error, conversationId }, 'Failed to store conversation memory');
      throw error;
    }
  }

  async getConversationContext(
    conversationId: string,
    query?: string,
    limit: number = 10
  ): Promise<ConversationContext> {
    if (!this.enabled) {
      return { conversationId, context: [], query: query || null };
    }

    try {
      const params = new URLSearchParams();
      if (query) params.set('query', query);
      params.set('limit', limit.toString());

      const response = await fetch(
        `${this.serviceUrl}/conversations/${conversationId}/context?${params}`,
        { method: 'GET' }
      );

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Failed to get conversation context: ${error}`);
      }

      const result = (await response.json()) as ContextApiResponse;
      return {
        conversationId: result.conversation_id,
        context: result.context.map((c) => ({
          role: c.role,
          content: c.content,
          timestamp: c.timestamp,
          relevanceScore: c.relevance_score,
        })),
        query: result.query,
      };
    } catch (error) {
      logger.error({ error, conversationId }, 'Failed to get conversation context');
      throw error;
    }
  }

  async deleteConversation(conversationId: string): Promise<{ deleted: boolean }> {
    if (!this.enabled) {
      return { deleted: false };
    }

    try {
      const response = await fetch(`${this.serviceUrl}/conversations/${conversationId}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Failed to delete conversation: ${error}`);
      }

      const result = (await response.json()) as DeleteResponse;
      return { deleted: result.deleted };
    } catch (error) {
      logger.error({ error, conversationId }, 'Failed to delete conversation');
      throw error;
    }
  }

  async healthCheck(): Promise<{ status: string; database: string }> {
    try {
      const response = await fetch(`${this.serviceUrl}/health`);
      return (await response.json()) as HealthResponse;
    } catch (error) {
      logger.error({ error }, 'Health check failed');
      return { status: 'error', database: 'disconnected' };
    }
  }
}
