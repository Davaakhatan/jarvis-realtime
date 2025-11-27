import { EventEmitter } from 'events';
import { createChildLogger } from '../../shared/utils/index';

const logger = createChildLogger('wake-word-service');

export interface WakeWordConfig {
  wakeWords?: string[];
  interruptWords?: string[];
  sensitivity?: number;
  debounceMs?: number;
}

export interface WakeWordDetection {
  type: 'wake' | 'interrupt';
  word: string;
  confidence: number;
  timestamp: Date;
}

const DEFAULT_WAKE_WORDS = ['jarvis', 'hey jarvis', 'ok jarvis'];
const DEFAULT_INTERRUPT_WORDS = [
  'stop',
  'cancel',
  'wait',
  'hold on',
  'pause',
  'never mind',
  'nevermind',
  'shut up',
  'quiet',
  'silence',
  'enough',
];

export class WakeWordService extends EventEmitter {
  private config: Required<WakeWordConfig>;
  private lastDetection: Date | null = null;
  private isEnabled = true;

  constructor(config: WakeWordConfig = {}) {
    super();
    this.config = {
      wakeWords: config.wakeWords || DEFAULT_WAKE_WORDS,
      interruptWords: config.interruptWords || DEFAULT_INTERRUPT_WORDS,
      sensitivity: config.sensitivity ?? 0.7,
      debounceMs: config.debounceMs ?? 1000,
    };
  }

  enable(): void {
    this.isEnabled = true;
    logger.info('Wake word detection enabled');
  }

  disable(): void {
    this.isEnabled = false;
    logger.info('Wake word detection disabled');
  }

  /**
   * Check if the transcript contains wake words or interrupt commands.
   * This is called with each ASR transcript result.
   */
  checkTranscript(text: string): WakeWordDetection | null {
    if (!this.isEnabled) {
      return null;
    }

    const normalizedText = text.toLowerCase().trim();

    // Check for debounce
    if (this.lastDetection) {
      const timeSinceLastDetection = Date.now() - this.lastDetection.getTime();
      if (timeSinceLastDetection < this.config.debounceMs) {
        return null;
      }
    }

    // Check for interrupt words first (higher priority)
    const interruptDetection = this.detectInterruptWord(normalizedText);
    if (interruptDetection) {
      this.lastDetection = new Date();
      this.emit('interrupt', interruptDetection);
      logger.info({ word: interruptDetection.word }, 'Interrupt word detected');
      return interruptDetection;
    }

    // Check for wake words
    const wakeDetection = this.detectWakeWord(normalizedText);
    if (wakeDetection) {
      this.lastDetection = new Date();
      this.emit('wake', wakeDetection);
      logger.info({ word: wakeDetection.word }, 'Wake word detected');
      return wakeDetection;
    }

    return null;
  }

  private detectWakeWord(text: string): WakeWordDetection | null {
    for (const word of this.config.wakeWords) {
      const wordLower = word.toLowerCase();

      // Check for exact match at start of text
      if (text.startsWith(wordLower)) {
        return {
          type: 'wake',
          word: word,
          confidence: 1.0,
          timestamp: new Date(),
        };
      }

      // Check for fuzzy match using similarity
      const similarity = this.calculateSimilarity(text.split(' ')[0], wordLower);
      if (similarity >= this.config.sensitivity) {
        return {
          type: 'wake',
          word: word,
          confidence: similarity,
          timestamp: new Date(),
        };
      }
    }

    return null;
  }

  private detectInterruptWord(text: string): WakeWordDetection | null {
    for (const word of this.config.interruptWords) {
      const wordLower = word.toLowerCase();

      // Check if text contains the interrupt word
      if (text.includes(wordLower)) {
        return {
          type: 'interrupt',
          word: word,
          confidence: 1.0,
          timestamp: new Date(),
        };
      }

      // Check for fuzzy match at the start
      const firstWords = text.split(' ').slice(0, word.split(' ').length).join(' ');
      const similarity = this.calculateSimilarity(firstWords, wordLower);
      if (similarity >= this.config.sensitivity) {
        return {
          type: 'interrupt',
          word: word,
          confidence: similarity,
          timestamp: new Date(),
        };
      }
    }

    return null;
  }

  /**
   * Calculate string similarity using Levenshtein distance
   */
  private calculateSimilarity(str1: string, str2: string): number {
    if (str1 === str2) return 1.0;
    if (str1.length === 0 || str2.length === 0) return 0.0;

    const matrix: number[][] = [];

    for (let i = 0; i <= str1.length; i++) {
      matrix[i] = [i];
    }

    for (let j = 0; j <= str2.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= str1.length; i++) {
      for (let j = 1; j <= str2.length; j++) {
        const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,      // deletion
          matrix[i][j - 1] + 1,      // insertion
          matrix[i - 1][j - 1] + cost // substitution
        );
      }
    }

    const distance = matrix[str1.length][str2.length];
    const maxLength = Math.max(str1.length, str2.length);
    return 1 - distance / maxLength;
  }

  /**
   * Extract the command text after the wake word
   */
  extractCommandAfterWakeWord(text: string, wakeWord: string): string {
    const normalizedText = text.toLowerCase();
    const normalizedWakeWord = wakeWord.toLowerCase();

    const index = normalizedText.indexOf(normalizedWakeWord);
    if (index === -1) {
      return text;
    }

    const afterWakeWord = text.substring(index + wakeWord.length).trim();
    // Remove any trailing punctuation or filler words
    return afterWakeWord
      .replace(/^[,.\s]+/, '')
      .replace(/^(please|can you|could you|would you)\s+/i, '')
      .trim();
  }

  addWakeWord(word: string): void {
    if (!this.config.wakeWords.includes(word.toLowerCase())) {
      this.config.wakeWords.push(word.toLowerCase());
      logger.info({ word }, 'Wake word added');
    }
  }

  removeWakeWord(word: string): void {
    const index = this.config.wakeWords.indexOf(word.toLowerCase());
    if (index > -1) {
      this.config.wakeWords.splice(index, 1);
      logger.info({ word }, 'Wake word removed');
    }
  }

  addInterruptWord(word: string): void {
    if (!this.config.interruptWords.includes(word.toLowerCase())) {
      this.config.interruptWords.push(word.toLowerCase());
      logger.info({ word }, 'Interrupt word added');
    }
  }

  removeInterruptWord(word: string): void {
    const index = this.config.interruptWords.indexOf(word.toLowerCase());
    if (index > -1) {
      this.config.interruptWords.splice(index, 1);
      logger.info({ word }, 'Interrupt word removed');
    }
  }

  getWakeWords(): string[] {
    return [...this.config.wakeWords];
  }

  getInterruptWords(): string[] {
    return [...this.config.interruptWords];
  }
}
