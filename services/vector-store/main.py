"""
Vector Store Service - Manages conversation memory and document embeddings
for context retrieval and RAG-based verification.
"""

import os
import hashlib
from contextlib import asynccontextmanager
from typing import AsyncGenerator
from datetime import datetime

import httpx
import structlog
import asyncpg
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

load_dotenv()

logger = structlog.get_logger()

# Configuration
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://jarvis:jarvis@localhost:5432/jarvis")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "text-embedding-3-small")
EMBEDDING_DIMENSIONS = 1536  # For text-embedding-3-small

# Database connection pool
db_pool: asyncpg.Pool | None = None


class Document(BaseModel):
    """A document to store in the vector database."""

    id: str
    content: str
    metadata: dict = {}
    source: str
    source_url: str | None = None


class SearchQuery(BaseModel):
    """Query for semantic search."""

    query: str
    top_k: int = 5
    filter_metadata: dict | None = None
    conversation_id: str | None = None


class SearchResult(BaseModel):
    """A single search result."""

    id: str
    content: str
    score: float
    metadata: dict
    source: str


class SearchResponse(BaseModel):
    """Response containing search results."""

    results: list[SearchResult]
    query: str


class ConversationMemory(BaseModel):
    """Store conversation context."""

    conversation_id: str
    messages: list[dict]


class MessageInput(BaseModel):
    """Single message to store."""

    role: str
    content: str
    timestamp: str | None = None


async def init_database():
    """Initialize database tables."""
    global db_pool

    db_pool = await asyncpg.create_pool(DATABASE_URL, min_size=2, max_size=10)

    async with db_pool.acquire() as conn:
        # Enable pgvector extension
        await conn.execute("CREATE EXTENSION IF NOT EXISTS vector")

        # Create documents table
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS documents (
                id TEXT PRIMARY KEY,
                content TEXT NOT NULL,
                embedding vector(1536),
                metadata JSONB DEFAULT '{}',
                source TEXT NOT NULL,
                source_url TEXT,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            )
        """)

        # Create conversation messages table
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS conversation_messages (
                id SERIAL PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                embedding vector(1536),
                timestamp TIMESTAMP DEFAULT NOW(),
                metadata JSONB DEFAULT '{}'
            )
        """)

        # Create indexes for efficient retrieval
        await conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_documents_embedding
            ON documents USING ivfflat (embedding vector_cosine_ops)
            WITH (lists = 100)
        """)

        await conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_conversation_messages_embedding
            ON conversation_messages USING ivfflat (embedding vector_cosine_ops)
            WITH (lists = 100)
        """)

        await conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_conversation_messages_conversation_id
            ON conversation_messages (conversation_id)
        """)

    logger.info("database_initialized")


async def close_database():
    """Close database connection pool."""
    global db_pool
    if db_pool:
        await db_pool.close()
        logger.info("database_closed")


async def get_embedding(text: str) -> list[float]:
    """Generate embedding using OpenAI API."""
    if not OPENAI_API_KEY:
        raise HTTPException(status_code=500, detail="OpenAI API key not configured")

    async with httpx.AsyncClient() as client:
        response = await client.post(
            "https://api.openai.com/v1/embeddings",
            headers={
                "Authorization": f"Bearer {OPENAI_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "input": text,
                "model": EMBEDDING_MODEL,
            },
            timeout=30.0,
        )

        if response.status_code != 200:
            logger.error("embedding_error", status=response.status_code, body=response.text)
            raise HTTPException(status_code=500, detail="Failed to generate embedding")

        data = response.json()
        return data["data"][0]["embedding"]


def vector_to_string(embedding: list[float]) -> str:
    """Convert embedding list to PostgreSQL vector string."""
    return "[" + ",".join(str(x) for x in embedding) + "]"


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Application lifespan manager."""
    logger.info("vector_store_service_starting")
    try:
        await init_database()
    except Exception as e:
        logger.error("database_init_failed", error=str(e))
        # Continue without database for development
    yield
    await close_database()
    logger.info("vector_store_service_stopping")


app = FastAPI(
    title="Jarvis Vector Store Service",
    description="Manages embeddings and semantic search for conversation memory",
    version="0.1.0",
    lifespan=lifespan,
)


@app.get("/health")
async def health_check() -> dict:
    """Health check endpoint."""
    db_status = "connected" if db_pool else "disconnected"
    return {"status": "ok", "service": "vector-store", "database": db_status}


@app.post("/documents")
async def store_document(document: Document) -> dict:
    """
    Store a document with its embedding in the vector database.
    """
    logger.info(
        "store_document",
        doc_id=document.id,
        source=document.source,
        content_length=len(document.content),
    )

    if not db_pool:
        raise HTTPException(status_code=503, detail="Database not available")

    try:
        # Generate embedding
        embedding = await get_embedding(document.content)

        async with db_pool.acquire() as conn:
            # Upsert document
            await conn.execute("""
                INSERT INTO documents (id, content, embedding, metadata, source, source_url, updated_at)
                VALUES ($1, $2, $3::vector, $4, $5, $6, NOW())
                ON CONFLICT (id) DO UPDATE SET
                    content = EXCLUDED.content,
                    embedding = EXCLUDED.embedding,
                    metadata = EXCLUDED.metadata,
                    source = EXCLUDED.source,
                    source_url = EXCLUDED.source_url,
                    updated_at = NOW()
            """, document.id, document.content, vector_to_string(embedding),
                document.metadata, document.source, document.source_url)

        return {"stored": True, "id": document.id}

    except Exception as e:
        logger.error("store_document_error", error=str(e), doc_id=document.id)
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/documents/{document_id}")
async def delete_document(document_id: str) -> dict:
    """Delete a document from the vector database."""
    if not db_pool:
        raise HTTPException(status_code=503, detail="Database not available")

    async with db_pool.acquire() as conn:
        result = await conn.execute("DELETE FROM documents WHERE id = $1", document_id)

    return {"deleted": True, "id": document_id}


@app.post("/search", response_model=SearchResponse)
async def search_documents(query: SearchQuery) -> SearchResponse:
    """
    Perform semantic search across stored documents.
    """
    logger.info("search_query", query=query.query, top_k=query.top_k)

    if not db_pool:
        raise HTTPException(status_code=503, detail="Database not available")

    try:
        # Generate query embedding
        query_embedding = await get_embedding(query.query)

        async with db_pool.acquire() as conn:
            # Perform cosine similarity search
            rows = await conn.fetch("""
                SELECT id, content, metadata, source,
                       1 - (embedding <=> $1::vector) as score
                FROM documents
                ORDER BY embedding <=> $1::vector
                LIMIT $2
            """, vector_to_string(query_embedding), query.top_k)

            results = [
                SearchResult(
                    id=row["id"],
                    content=row["content"],
                    score=float(row["score"]),
                    metadata=row["metadata"] or {},
                    source=row["source"],
                )
                for row in rows
            ]

        return SearchResponse(results=results, query=query.query)

    except Exception as e:
        logger.error("search_error", error=str(e))
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/conversations/{conversation_id}/messages")
async def store_message(conversation_id: str, message: MessageInput) -> dict:
    """Store a single conversation message with embedding."""
    logger.info(
        "store_message",
        conversation_id=conversation_id,
        role=message.role,
    )

    if not db_pool:
        raise HTTPException(status_code=503, detail="Database not available")

    try:
        # Generate embedding for message content
        embedding = await get_embedding(message.content)

        timestamp = datetime.fromisoformat(message.timestamp) if message.timestamp else datetime.now()

        async with db_pool.acquire() as conn:
            await conn.execute("""
                INSERT INTO conversation_messages
                (conversation_id, role, content, embedding, timestamp)
                VALUES ($1, $2, $3, $4::vector, $5)
            """, conversation_id, message.role, message.content,
                vector_to_string(embedding), timestamp)

        return {"stored": True, "conversation_id": conversation_id}

    except Exception as e:
        logger.error("store_message_error", error=str(e))
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/conversations/{conversation_id}/memory")
async def store_conversation_memory(
    conversation_id: str, memory: ConversationMemory
) -> dict:
    """
    Store multiple conversation messages at once.
    """
    logger.info(
        "store_conversation",
        conversation_id=conversation_id,
        message_count=len(memory.messages),
    )

    if not db_pool:
        raise HTTPException(status_code=503, detail="Database not available")

    try:
        for msg in memory.messages:
            embedding = await get_embedding(msg.get("content", ""))
            timestamp = msg.get("timestamp", datetime.now().isoformat())
            if isinstance(timestamp, str):
                timestamp = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))

            async with db_pool.acquire() as conn:
                await conn.execute("""
                    INSERT INTO conversation_messages
                    (conversation_id, role, content, embedding, timestamp)
                    VALUES ($1, $2, $3, $4::vector, $5)
                """, conversation_id, msg.get("role", "user"),
                    msg.get("content", ""), vector_to_string(embedding), timestamp)

        return {"stored": True, "conversation_id": conversation_id, "count": len(memory.messages)}

    except Exception as e:
        logger.error("store_conversation_error", error=str(e))
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/conversations/{conversation_id}/context")
async def get_conversation_context(
    conversation_id: str, query: str | None = None, limit: int = 10
) -> dict:
    """
    Retrieve relevant conversation context.
    If query is provided, performs semantic search.
    Otherwise returns recent messages.
    """
    logger.info(
        "get_context", conversation_id=conversation_id, query=query, limit=limit
    )

    if not db_pool:
        raise HTTPException(status_code=503, detail="Database not available")

    try:
        async with db_pool.acquire() as conn:
            if query:
                # Semantic search within conversation
                query_embedding = await get_embedding(query)
                rows = await conn.fetch("""
                    SELECT role, content, timestamp,
                           1 - (embedding <=> $1::vector) as score
                    FROM conversation_messages
                    WHERE conversation_id = $2
                    ORDER BY embedding <=> $1::vector
                    LIMIT $3
                """, vector_to_string(query_embedding), conversation_id, limit)
            else:
                # Get recent messages
                rows = await conn.fetch("""
                    SELECT role, content, timestamp, 1.0 as score
                    FROM conversation_messages
                    WHERE conversation_id = $1
                    ORDER BY timestamp DESC
                    LIMIT $2
                """, conversation_id, limit)

            context = [
                {
                    "role": row["role"],
                    "content": row["content"],
                    "timestamp": row["timestamp"].isoformat() if row["timestamp"] else None,
                    "relevance_score": float(row["score"]),
                }
                for row in rows
            ]

            # Reverse if getting recent (so oldest first)
            if not query:
                context.reverse()

        return {"conversation_id": conversation_id, "context": context, "query": query}

    except Exception as e:
        logger.error("get_context_error", error=str(e))
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/conversations/{conversation_id}")
async def delete_conversation(conversation_id: str) -> dict:
    """Delete all messages for a conversation."""
    if not db_pool:
        raise HTTPException(status_code=503, detail="Database not available")

    async with db_pool.acquire() as conn:
        result = await conn.execute(
            "DELETE FROM conversation_messages WHERE conversation_id = $1",
            conversation_id
        )

    return {"deleted": True, "conversation_id": conversation_id}


@app.post("/search/hybrid")
async def hybrid_search(query: SearchQuery) -> SearchResponse:
    """
    Perform hybrid search combining documents and conversation context.
    """
    logger.info("hybrid_search", query=query.query, conversation_id=query.conversation_id)

    if not db_pool:
        raise HTTPException(status_code=503, detail="Database not available")

    try:
        query_embedding = await get_embedding(query.query)
        results = []

        async with db_pool.acquire() as conn:
            # Search documents
            doc_rows = await conn.fetch("""
                SELECT id, content, metadata, source,
                       1 - (embedding <=> $1::vector) as score
                FROM documents
                ORDER BY embedding <=> $1::vector
                LIMIT $2
            """, vector_to_string(query_embedding), query.top_k)

            for row in doc_rows:
                results.append(SearchResult(
                    id=row["id"],
                    content=row["content"],
                    score=float(row["score"]),
                    metadata=row["metadata"] or {},
                    source=row["source"],
                ))

            # If conversation_id provided, also search conversation history
            if query.conversation_id:
                conv_rows = await conn.fetch("""
                    SELECT conversation_id || ':' || id::text as id,
                           content,
                           1 - (embedding <=> $1::vector) as score,
                           role
                    FROM conversation_messages
                    WHERE conversation_id = $2
                    ORDER BY embedding <=> $1::vector
                    LIMIT $3
                """, vector_to_string(query_embedding), query.conversation_id, query.top_k)

                for row in conv_rows:
                    results.append(SearchResult(
                        id=row["id"],
                        content=row["content"],
                        score=float(row["score"]),
                        metadata={"role": row["role"]},
                        source="conversation",
                    ))

        # Sort by score and take top_k
        results.sort(key=lambda x: x.score, reverse=True)
        results = results[:query.top_k]

        return SearchResponse(results=results, query=query.query)

    except Exception as e:
        logger.error("hybrid_search_error", error=str(e))
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=int(os.getenv("PORT", "8004")),
        reload=os.getenv("ENV", "development") == "development",
    )
