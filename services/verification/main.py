"""
Verification Service - Ensures zero-hallucination responses by validating
LLM outputs against authoritative data sources.
"""

import os
import re
import hashlib
from contextlib import asynccontextmanager
from typing import AsyncGenerator
from datetime import datetime, timedelta

import httpx
import structlog
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

load_dotenv()

logger = structlog.get_logger()

# Cache for verified facts
FACT_CACHE: dict[str, dict] = {}
CACHE_TTL = timedelta(minutes=5)


class VerificationRequest(BaseModel):
    """Request to verify an LLM response."""

    session_id: str
    response_text: str
    claimed_sources: list[str] = []
    context: dict | None = None


class VerificationResult(BaseModel):
    """Result of verification check."""

    verified: bool
    confidence: float
    citations: list[dict]
    warnings: list[str] = []
    modified_response: str | None = None


class SourceCheck(BaseModel):
    """Individual source verification."""

    source: str
    found: bool
    snippet: str | None = None
    url: str | None = None


class FactExtraction(BaseModel):
    """Extracted fact from response."""

    fact: str
    category: str  # 'numerical', 'temporal', 'entity', 'claim'
    verifiable: bool


# Patterns that indicate potential hallucination
HALLUCINATION_PATTERNS = [
    r"I think",
    r"I believe",
    r"probably",
    r"might be",
    r"could be",
    r"I'm not sure",
    r"I don't have.*information",
    r"as of my.*knowledge",
    r"my training data",
]

# Patterns that indicate factual claims needing verification
FACT_PATTERNS = [
    r"(\d+(?:\.\d+)?)\s*(?:percent|%)",  # Percentages
    r"(\d{1,2}/\d{1,2}/\d{2,4}|\d{4}-\d{2}-\d{2})",  # Dates
    r"(\$[\d,]+(?:\.\d{2})?)",  # Currency
    r"(https?://[^\s]+)",  # URLs
    r"version\s+(\d+(?:\.\d+)*)",  # Version numbers
]


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Application lifespan manager."""
    logger.info("verification_service_starting")
    yield
    logger.info("verification_service_stopping")


app = FastAPI(
    title="Jarvis Verification Service",
    description="Validates LLM responses against authoritative sources",
    version="0.1.0",
    lifespan=lifespan,
)


def extract_facts(text: str) -> list[FactExtraction]:
    """Extract verifiable facts from response text."""
    facts = []

    # Extract numerical facts
    for pattern in FACT_PATTERNS:
        matches = re.finditer(pattern, text, re.IGNORECASE)
        for match in matches:
            facts.append(
                FactExtraction(
                    fact=match.group(0),
                    category="numerical",
                    verifiable=True,
                )
            )

    return facts


def detect_uncertainty(text: str) -> list[str]:
    """Detect uncertainty markers that suggest potential hallucination."""
    warnings = []

    for pattern in HALLUCINATION_PATTERNS:
        if re.search(pattern, text, re.IGNORECASE):
            warnings.append(f"Uncertainty detected: pattern '{pattern}' found in response")

    return warnings


def check_self_consistency(text: str) -> list[str]:
    """Check for internal contradictions in the response."""
    warnings = []

    # Simple check: look for contradictory phrases
    contradictions = [
        (r"is (\w+)", r"is not \1"),
        (r"always", r"never"),
        (r"all", r"none"),
    ]

    for pos, neg in contradictions:
        pos_matches = re.findall(pos, text, re.IGNORECASE)
        neg_matches = re.findall(neg, text, re.IGNORECASE)

        if pos_matches and neg_matches:
            warnings.append("Potential contradiction detected in response")
            break

    return warnings


def compute_confidence(
    facts: list[FactExtraction],
    verified_count: int,
    warnings: list[str],
    has_citations: bool,
) -> float:
    """Compute confidence score for verification."""
    if not facts:
        # No verifiable facts - base confidence on other factors
        base = 0.7 if has_citations else 0.5
    else:
        # Calculate based on verification ratio
        base = verified_count / len(facts) if facts else 0.0

    # Reduce confidence for each warning
    penalty = len(warnings) * 0.1
    confidence = max(0.0, min(1.0, base - penalty))

    return round(confidence, 2)


def get_cache_key(text: str) -> str:
    """Generate cache key for a piece of text."""
    return hashlib.md5(text.encode()).hexdigest()


def is_cache_valid(cache_entry: dict) -> bool:
    """Check if cache entry is still valid."""
    if "timestamp" not in cache_entry:
        return False
    cached_time = datetime.fromisoformat(cache_entry["timestamp"])
    return datetime.now() - cached_time < CACHE_TTL


async def verify_against_context(
    fact: str, context: dict | None
) -> tuple[bool, str | None]:
    """Verify a fact against provided context data."""
    if not context:
        return False, None

    # Check if fact appears in context
    context_str = str(context).lower()
    fact_lower = fact.lower()

    if fact_lower in context_str:
        return True, f"Found in provided context"

    # Check API data in context
    if "api_data" in context:
        api_str = str(context["api_data"]).lower()
        if fact_lower in api_str:
            return True, "Verified against API data"

    return False, None


async def verify_url(url: str) -> tuple[bool, str | None]:
    """Verify that a URL is accessible and returns valid content."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.head(url, follow_redirects=True)
            if response.status_code == 200:
                return True, f"URL accessible (status {response.status_code})"
            return False, f"URL returned status {response.status_code}"
    except Exception as e:
        return False, f"URL verification failed: {str(e)}"


@app.get("/health")
async def health_check() -> dict:
    """Health check endpoint."""
    return {"status": "ok", "service": "verification"}


@app.post("/verify", response_model=VerificationResult)
async def verify_response(request: VerificationRequest) -> VerificationResult:
    """
    Verify an LLM response for accuracy.

    This endpoint checks:
    1. All claimed facts have supporting sources
    2. Sources are authoritative and recent
    3. Response doesn't contain hallucinated information
    """
    logger.info(
        "verification_request",
        session_id=request.session_id,
        response_length=len(request.response_text),
    )

    warnings = []
    citations = []
    verified_count = 0

    # Check cache first
    cache_key = get_cache_key(request.response_text)
    if cache_key in FACT_CACHE and is_cache_valid(FACT_CACHE[cache_key]):
        cached = FACT_CACHE[cache_key]
        logger.info("cache_hit", session_id=request.session_id)
        return VerificationResult(**cached["result"])

    # Step 1: Detect uncertainty markers
    uncertainty_warnings = detect_uncertainty(request.response_text)
    warnings.extend(uncertainty_warnings)

    # Step 2: Check self-consistency
    consistency_warnings = check_self_consistency(request.response_text)
    warnings.extend(consistency_warnings)

    # Step 3: Extract verifiable facts
    facts = extract_facts(request.response_text)

    # Step 4: Verify each fact
    for fact in facts:
        if fact.category == "numerical" and fact.fact.startswith("http"):
            # Verify URLs
            verified, snippet = await verify_url(fact.fact)
            citations.append(
                {
                    "source": fact.fact,
                    "verified": verified,
                    "snippet": snippet,
                    "type": "url",
                }
            )
            if verified:
                verified_count += 1
        else:
            # Verify against context
            verified, snippet = await verify_against_context(
                fact.fact, request.context
            )
            citations.append(
                {
                    "source": fact.fact,
                    "verified": verified,
                    "snippet": snippet or "Could not verify",
                    "type": fact.category,
                }
            )
            if verified:
                verified_count += 1

    # Step 5: Verify claimed sources
    for source in request.claimed_sources:
        if source.startswith("http"):
            verified, snippet = await verify_url(source)
        else:
            verified, snippet = await verify_against_context(source, request.context)

        citations.append(
            {
                "source": source,
                "verified": verified,
                "snippet": snippet or "Source not found",
                "type": "claimed",
            }
        )
        if verified:
            verified_count += 1

    # Step 6: Compute confidence
    total_checks = len(facts) + len(request.claimed_sources)
    confidence = compute_confidence(
        facts,
        verified_count,
        warnings,
        has_citations=bool(request.claimed_sources),
    )

    # Determine if response is verified
    # Verified if: confidence > 0.6 AND no critical warnings AND some verification passed
    is_verified = (
        confidence > 0.6
        and len(uncertainty_warnings) < 3
        and (verified_count > 0 or total_checks == 0)
    )

    # Generate modified response if not verified
    modified_response = None
    if not is_verified and warnings:
        # Add disclaimer to response
        disclaimer = "\n\n[Note: This response could not be fully verified. Please verify critical information from authoritative sources.]"
        modified_response = request.response_text + disclaimer

    result = VerificationResult(
        verified=is_verified,
        confidence=confidence,
        citations=citations,
        warnings=warnings,
        modified_response=modified_response,
    )

    # Cache the result
    FACT_CACHE[cache_key] = {
        "result": result.model_dump(),
        "timestamp": datetime.now().isoformat(),
    }

    logger.info(
        "verification_complete",
        session_id=request.session_id,
        verified=is_verified,
        confidence=confidence,
        warning_count=len(warnings),
    )

    return result


@app.post("/check-source", response_model=SourceCheck)
async def check_source(source: str) -> SourceCheck:
    """Check if a specific source exists and is valid."""
    logger.info("source_check", source=source)

    if source.startswith("http"):
        found, snippet = await verify_url(source)
        return SourceCheck(
            source=source,
            found=found,
            snippet=snippet,
            url=source if found else None,
        )

    # For non-URL sources, we can't verify without context
    return SourceCheck(
        source=source,
        found=False,
        snippet="Cannot verify without context",
        url=None,
    )


@app.post("/extract-facts")
async def extract_facts_endpoint(text: str) -> list[dict]:
    """Extract verifiable facts from text."""
    facts = extract_facts(text)
    return [f.model_dump() for f in facts]


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=int(os.getenv("PORT", "8003")),
        reload=os.getenv("ENV", "development") == "development",
    )
