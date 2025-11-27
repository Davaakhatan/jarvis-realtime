import { createChildLogger } from '../../shared/utils/index';

const logger = createChildLogger('verification-engine');

export interface VerificationClaim {
  text: string;
  type: 'factual' | 'numerical' | 'temporal' | 'reference' | 'opinion';
  confidence: number;
  source?: string;
  verified: boolean;
}

export interface VerificationContext {
  apiData?: Record<string, unknown>;
  githubData?: unknown[];
  conversationHistory?: Array<{ role: string; content: string }>;
  knowledgeBase?: string[];
}

export interface EngineVerificationResult {
  verified: boolean;
  confidence: number;
  claims: VerificationClaim[];
  citations: Array<{
    source: string;
    verified: boolean;
    snippet: string | null;
    type: string;
  }>;
  warnings: string[];
  modifiedResponse: string | null;
}

interface ClaimMatch {
  claim: string;
  source: string;
  snippet: string;
  similarity: number;
}

export class VerificationEngine {
  private apiKey: string;
  private minConfidenceThreshold: number;

  constructor(apiKey: string, minConfidenceThreshold = 0.6) {
    this.apiKey = apiKey;
    this.minConfidenceThreshold = minConfidenceThreshold;
  }

  async verify(
    responseText: string,
    context: VerificationContext
  ): Promise<EngineVerificationResult> {
    logger.debug({ responseLength: responseText.length }, 'Starting verification');

    // Step 1: Extract claims from response
    const claims = this.extractClaims(responseText);
    logger.debug({ claimCount: claims.length }, 'Extracted claims');

    if (claims.length === 0) {
      // No factual claims - likely opinion or greeting
      return {
        verified: true,
        confidence: 1.0,
        claims: [],
        citations: [],
        warnings: [],
        modifiedResponse: null,
      };
    }

    // Step 2: Verify each claim against context
    const verifiedClaims = await this.verifyClaims(claims, context);

    // Step 3: Calculate overall confidence
    const verifiedCount = verifiedClaims.filter((c) => c.verified).length;
    const overallConfidence =
      verifiedClaims.length > 0 ? verifiedCount / verifiedClaims.length : 1.0;

    // Step 4: Generate citations from verified claims
    const citations = this.generateCitations(verifiedClaims);

    // Step 5: Determine if response passes verification
    const verified = overallConfidence >= this.minConfidenceThreshold;

    // Step 6: Generate warnings for unverified claims
    const warnings = verifiedClaims
      .filter((c) => !c.verified)
      .map((c) => `Unverified claim: "${c.text.substring(0, 50)}..."`);

    // Step 7: Modify response if verification fails
    let modifiedResponse: string | null = null;
    if (!verified) {
      modifiedResponse = this.modifyResponse(responseText, verifiedClaims);
    }

    logger.debug(
      {
        verified,
        confidence: overallConfidence,
        citationCount: citations.length,
        warningCount: warnings.length,
      },
      'Verification complete'
    );

    return {
      verified,
      confidence: overallConfidence,
      claims: verifiedClaims,
      citations,
      warnings,
      modifiedResponse,
    };
  }

  private extractClaims(text: string): VerificationClaim[] {
    const claims: VerificationClaim[] = [];

    // Split into sentences
    const sentences = text
      .split(/[.!?]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 10);

    for (const sentence of sentences) {
      const claimType = this.classifyClaimType(sentence);

      // Skip opinions and subjective statements
      if (claimType === 'opinion') {
        continue;
      }

      claims.push({
        text: sentence,
        type: claimType,
        confidence: 0,
        verified: false,
      });
    }

    return claims;
  }

  private classifyClaimType(
    text: string
  ): 'factual' | 'numerical' | 'temporal' | 'reference' | 'opinion' {
    const lowerText = text.toLowerCase();

    // Opinion indicators
    const opinionPatterns = [
      /^i think/,
      /^i believe/,
      /^in my opinion/,
      /^probably/,
      /^maybe/,
      /^perhaps/,
      /should/,
      /might/,
      /could be/,
      /seems like/,
      /appears to/,
    ];

    if (opinionPatterns.some((p) => p.test(lowerText))) {
      return 'opinion';
    }

    // Numerical claims (statistics, counts, percentages)
    if (/\d+%|\d+\s*(percent|million|billion|thousand)|\$\d+/i.test(text)) {
      return 'numerical';
    }

    // Temporal claims (dates, times, durations)
    if (
      /\d{4}|yesterday|today|tomorrow|last\s+\w+|next\s+\w+|ago|since/i.test(
        text
      )
    ) {
      return 'temporal';
    }

    // Reference claims (citing specific sources)
    if (/according to|based on|as stated in|from\s+\w+/i.test(text)) {
      return 'reference';
    }

    // Default to factual
    return 'factual';
  }

  private async verifyClaims(
    claims: VerificationClaim[],
    context: VerificationContext
  ): Promise<VerificationClaim[]> {
    const verifiedClaims: VerificationClaim[] = [];

    // Flatten context into searchable text
    const contextTexts = this.flattenContext(context);

    for (const claim of claims) {
      const match = this.findBestMatch(claim.text, contextTexts);

      if (match && match.similarity >= 0.5) {
        verifiedClaims.push({
          ...claim,
          verified: true,
          confidence: match.similarity,
          source: match.source,
        });
      } else {
        // Check if claim is general knowledge (safe assertions)
        const isGeneralKnowledge = this.isGeneralKnowledge(claim.text);

        verifiedClaims.push({
          ...claim,
          verified: isGeneralKnowledge,
          confidence: isGeneralKnowledge ? 0.7 : 0.2,
          source: isGeneralKnowledge ? 'general_knowledge' : undefined,
        });
      }
    }

    return verifiedClaims;
  }

  private flattenContext(context: VerificationContext): ClaimMatch[] {
    const texts: ClaimMatch[] = [];

    // Flatten API data
    if (context.apiData) {
      for (const [key, value] of Object.entries(context.apiData)) {
        const flatText = this.flattenObject(value, key);
        texts.push(
          ...flatText.map((t) => ({
            claim: '',
            source: `api:${key}`,
            snippet: t,
            similarity: 0,
          }))
        );
      }
    }

    // Flatten GitHub data
    if (context.githubData) {
      for (const item of context.githubData) {
        const flatText = this.flattenObject(item, 'github');
        texts.push(
          ...flatText.map((t) => ({
            claim: '',
            source: 'github',
            snippet: t,
            similarity: 0,
          }))
        );
      }
    }

    // Add conversation history
    if (context.conversationHistory) {
      for (const msg of context.conversationHistory) {
        texts.push({
          claim: '',
          source: `conversation:${msg.role}`,
          snippet: msg.content,
          similarity: 0,
        });
      }
    }

    // Add knowledge base
    if (context.knowledgeBase) {
      for (const knowledge of context.knowledgeBase) {
        texts.push({
          claim: '',
          source: 'knowledge_base',
          snippet: knowledge,
          similarity: 0,
        });
      }
    }

    return texts;
  }

  private flattenObject(obj: unknown, prefix: string): string[] {
    const texts: string[] = [];

    if (typeof obj === 'string') {
      texts.push(obj);
    } else if (typeof obj === 'number' || typeof obj === 'boolean') {
      texts.push(`${prefix}: ${obj}`);
    } else if (Array.isArray(obj)) {
      for (const item of obj) {
        texts.push(...this.flattenObject(item, prefix));
      }
    } else if (obj && typeof obj === 'object') {
      for (const [key, value] of Object.entries(obj)) {
        texts.push(...this.flattenObject(value, `${prefix}.${key}`));
      }
    }

    return texts;
  }

  private findBestMatch(claim: string, contextTexts: ClaimMatch[]): ClaimMatch | null {
    let bestMatch: ClaimMatch | null = null;
    let bestSimilarity = 0;

    const claimWords = this.tokenize(claim);

    for (const ctx of contextTexts) {
      const similarity = this.calculateSimilarity(claimWords, ctx.snippet);

      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestMatch = {
          claim,
          source: ctx.source,
          snippet: ctx.snippet.substring(0, 200),
          similarity,
        };
      }
    }

    return bestMatch;
  }

  private tokenize(text: string): Set<string> {
    return new Set(
      text
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .split(/\s+/)
        .filter((w) => w.length > 2)
    );
  }

  private calculateSimilarity(claimWords: Set<string>, contextText: string): number {
    const contextWords = this.tokenize(contextText);

    if (claimWords.size === 0 || contextWords.size === 0) {
      return 0;
    }

    // Jaccard similarity with key term weighting
    let intersection = 0;
    const keyTerms = [
      'error',
      'issue',
      'bug',
      'version',
      'update',
      'status',
      'count',
      'total',
      'name',
      'id',
    ];

    for (const word of claimWords) {
      if (contextWords.has(word)) {
        intersection += keyTerms.includes(word) ? 2 : 1;
      }
    }

    const union = claimWords.size + contextWords.size - intersection;
    return intersection / union;
  }

  private isGeneralKnowledge(text: string): boolean {
    const lowerText = text.toLowerCase();

    // Safe general assertions - these don't need external verification
    const generalPatterns = [
      // Greetings and pleasantries
      /^hello|^hi|^hey/,
      /how can i help/,
      /how can i assist/,
      /i can help you with/,
      /let me know if/,
      /feel free to/,
      /i'm here to/,
      /you're welcome/,
      /thank you/,
      /is there anything/,
      /what would you like/,
      /what can i do/,

      // Honest uncertainty statements (should be rewarded, not penalized)
      /i don't have (that |this )?(information|data|access)/,
      /i cannot verify/,
      /i'm not sure/,
      /i would need to check/,
      /i don't have.*in my (current )?data/,
      /i cannot confirm/,
      /i'm unable to/,
      /i can't find/,
      /no information available/,
      /not in (my |the )?context/,

      // Self-referential statements about capabilities
      /i('m| am) jarvis/,
      /i('m| am) a voice assistant/,
      /i('m| am) here to help/,
      /i('m| am) designed to/,
      /my purpose is/,

      // Questions and prompts to user
      /could you (please )?/,
      /would you like/,
      /do you want/,
      /can you tell me/,
      /what (do you|would you)/,
      /\?$/, // Ends with question mark
    ];

    return generalPatterns.some((p) => p.test(lowerText));
  }

  private generateCitations(claims: VerificationClaim[]): Array<{
    source: string;
    verified: boolean;
    snippet: string | null;
    type: string;
  }> {
    const citations: Array<{
      source: string;
      verified: boolean;
      snippet: string | null;
      type: string;
    }> = [];

    const seenSources = new Set<string>();

    for (const claim of claims) {
      if (claim.source && claim.verified && !seenSources.has(claim.source)) {
        seenSources.add(claim.source);
        citations.push({
          source: claim.source,
          verified: true,
          snippet: claim.text.substring(0, 100),
          type: claim.type,
        });
      }
    }

    return citations;
  }

  private modifyResponse(
    response: string,
    claims: VerificationClaim[]
  ): string {
    const unverifiedClaims = claims.filter((c) => !c.verified);

    if (unverifiedClaims.length === 0) {
      return response;
    }

    // Add disclaimer at the end
    const disclaimer =
      "\n\nNote: Some information in this response could not be verified against available data sources. Please verify critical information independently.";

    return response + disclaimer;
  }

  async verifyWithLLM(
    responseText: string,
    context: VerificationContext
  ): Promise<EngineVerificationResult> {
    // Use LLM to perform deeper verification
    try {
      const verificationPrompt = this.buildVerificationPrompt(
        responseText,
        context
      );

      const response = await fetch(
        'https://api.openai.com/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'gpt-4-turbo-preview',
            messages: [
              {
                role: 'system',
                content: `You are a fact-checking assistant. Analyze the given response and verify each factual claim against the provided context. Return a JSON object with:
{
  "verified": boolean,
  "confidence": number (0-1),
  "claims": [{ "text": string, "verified": boolean, "source": string | null }],
  "warnings": string[]
}`,
              },
              { role: 'user', content: verificationPrompt },
            ],
            max_tokens: 1024,
            temperature: 0.1,
            response_format: { type: 'json_object' },
          }),
        }
      );

      if (!response.ok) {
        throw new Error('LLM verification failed');
      }

      const result = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      const parsed = JSON.parse(result.choices[0].message.content) as {
        verified: boolean;
        confidence: number;
        claims: Array<{ text: string; verified: boolean; source: string | null }>;
        warnings: string[];
      };

      return {
        verified: parsed.verified,
        confidence: parsed.confidence,
        claims: parsed.claims.map((c) => ({
          text: c.text,
          type: 'factual' as const,
          confidence: c.verified ? 0.9 : 0.3,
          verified: c.verified,
          source: c.source || undefined,
        })),
        citations: parsed.claims
          .filter((c) => c.verified && c.source)
          .map((c) => ({
            source: c.source!,
            verified: true,
            snippet: c.text.substring(0, 100),
            type: 'factual',
          })),
        warnings: parsed.warnings,
        modifiedResponse: parsed.verified
          ? null
          : responseText +
            '\n\nNote: This response contains unverified information.',
      };
    } catch (error) {
      logger.error({ error }, 'LLM verification failed, falling back to rule-based');
      return this.verify(responseText, context);
    }
  }

  private buildVerificationPrompt(
    response: string,
    context: VerificationContext
  ): string {
    let prompt = `Response to verify:\n"${response}"\n\nAvailable context:\n`;

    if (context.apiData) {
      prompt += `\nAPI Data:\n${JSON.stringify(context.apiData, null, 2)}`;
    }

    if (context.conversationHistory) {
      prompt += `\nConversation History:\n${context.conversationHistory
        .map((m) => `${m.role}: ${m.content}`)
        .join('\n')}`;
    }

    prompt +=
      '\n\nVerify each factual claim in the response. Mark as verified only if the claim is directly supported by the context or is a safe general statement.';

    return prompt;
  }
}
