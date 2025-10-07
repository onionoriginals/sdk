/**
 * Enhanced Logger for Originals SDK
 * 
 * Features:
 * - Multiple log levels (debug, info, warn, error)
 * - Child loggers with hierarchical context
 * - Performance timing with startTimer
 * - Multiple output destinations
 * - Data sanitization for sensitive information
 * - Async-safe operations
 */


import { appendFile } from 'node:fs/promises';

import type { OriginalsConfig } from '../types';

/**
 * Log level type
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Structured log entry
 */
export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  context: string;
  message: string;
  data?: any;
  duration?: number; // For performance tracking
  traceId?: string; // For request correlation
}

/**
 * Log output interface for custom outputs
 */
export interface LogOutput {
  write(entry: LogEntry): void | Promise<void>;
}

/**
 * Console log output implementation
 */
export class ConsoleLogOutput implements LogOutput {
  write(entry: LogEntry): void {
    const timestamp = entry.timestamp;
    const level = entry.level.toUpperCase().padEnd(5);
    const context = entry.context;
    const message = entry.message;
    const durationStr = entry.duration !== undefined ? ` (${entry.duration.toFixed(2)}ms)` : '';
    const dataStr = entry.data ? ` ${JSON.stringify(entry.data)}` : '';
    
    const logMessage = `[${timestamp}] ${level} [${context}] ${message}${durationStr}${dataStr}`;
    
    switch (entry.level) {
      case 'debug':
        console.debug(logMessage);
        break;
      case 'info':
        console.info(logMessage);
        break;
      case 'warn':
        console.warn(logMessage);
        break;
      case 'error':
        console.error(logMessage);
        break;
    }
  }
}

/**
 * File log output implementation (async)
 */
export class FileLogOutput implements LogOutput {
  private buffer: string[] = [];
  private flushTimeout: any = null;
  private readonly flushInterval = 1000; // Flush every 1 second
  
  constructor(private filePath: string) {}
  
  async write(entry: LogEntry): Promise<void> {
    // Format as JSON line
    const line = JSON.stringify(entry) + '\n';
    this.buffer.push(line);
    
    // Schedule flush
    if (!this.flushTimeout) {
      this.flushTimeout = setTimeout(() => this.flush(), this.flushInterval);
    }
  }
  
  private async flush(): Promise<void> {
    if (this.buffer.length === 0) {
      return;
    }
    
    const lines = this.buffer.join('');
    this.buffer = [];
    this.flushTimeout = null;
    
    try {
      // Use Bun's file API for efficient file writing
      const file = Bun.file(this.filePath);
      const exists = await file.exists();
      
      if (exists) {
        // Append to existing file
        const content = await file.text();
        await Bun.write(this.filePath, content + lines);
      } else {
        // Create new file
        await Bun.write(this.filePath, lines);
      }
      await appendFile(this.filePath, lines);
    } catch (err) {
      // Fallback to console on file write error
      console.error('Failed to write log file:', err);
    }
  }
}

/**
 * Main Logger class
 */
export class Logger {
  private outputs: LogOutput[] = [];
  private minLevel: LogLevel;
  private includeTimestamps: boolean;
  private includeContext: boolean;
  private sanitizeLogs: boolean;
  
  // Log level priorities
  private static readonly LEVEL_PRIORITY: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3
  };
  
  constructor(
    private context: string,
    config: OriginalsConfig
  ) {
    this.minLevel = config.logging?.level || 'info';
    this.includeTimestamps = config.logging?.includeTimestamps !== false;
    this.includeContext = config.logging?.includeContext !== false;
    this.sanitizeLogs = config.logging?.sanitizeLogs !== false;
    
    // Set up default outputs
    if (config.logging?.outputs && config.logging.outputs.length > 0) {
      this.outputs = [...config.logging.outputs];
    } else {
      // Default to console output
      this.outputs = [new ConsoleLogOutput()];
    }
  }
  
  /**
   * Log a debug message
   */
  debug(message: string, data?: any): void {
    this.log('debug', message, data);
  }
  
  /**
   * Log an info message
   */
  info(message: string, data?: any): void {
    this.log('info', message, data);
  }
  
  /**
   * Log a warning message
   */
  warn(message: string, data?: any): void {
    this.log('warn', message, data);
  }
  
  /**
   * Log an error message
   */
  error(message: string, error?: Error, data?: any): void {
    const errorData = error ? {
      ...data,
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack
      }
    } : data;
    
    this.log('error', message, errorData);
  }
  
  /**
   * Start a timer for performance tracking
   * Returns a function that stops the timer and logs the duration
   */
  startTimer(operation: string): () => void {
    const startTime = performance.now();
    
    return () => {
      const duration = performance.now() - startTime;
      this.log('debug', `${operation} completed`, undefined, duration);
    };
  }
  
  /**
   * Create a child logger with nested context
   */
  child(childContext: string): Logger {
    const newLogger = Object.create(Logger.prototype);
    newLogger.context = `${this.context}:${childContext}`;
    newLogger.outputs = this.outputs;
    newLogger.minLevel = this.minLevel;
    newLogger.includeTimestamps = this.includeTimestamps;
    newLogger.includeContext = this.includeContext;
    newLogger.sanitizeLogs = this.sanitizeLogs;
    return newLogger;
  }
  
  /**
   * Set a single output (replaces existing outputs)
   */
  setOutput(output: LogOutput): void {
    this.outputs = [output];
  }
  
  /**
   * Add an output to the existing outputs
   */
  addOutput(output: LogOutput): void {
    this.outputs.push(output);
  }
  
  /**
   * Internal log method
   */
  private log(level: LogLevel, message: string, data?: any, duration?: number): void {
    // Check if we should log this level
    if (Logger.LEVEL_PRIORITY[level] < Logger.LEVEL_PRIORITY[this.minLevel]) {
      return;
    }
    
    // Sanitize data if needed
    const sanitizedData = this.sanitizeLogs ? this.sanitize(data) : data;
    
    // Create log entry
    const entry: LogEntry = {
      timestamp: this.includeTimestamps ? new Date().toISOString() : '',
      level,
      context: this.includeContext ? this.context : '',
      message,
      data: sanitizedData,
      duration
    };
    
    // Write to all outputs (fire and forget for async outputs)
    for (const output of this.outputs) {
      try {
        const result = output.write(entry);
        // If result is a promise, don't await it (non-blocking)
        if (result instanceof Promise) {
          result.catch(err => {
            // Silently fail for async outputs to avoid blocking
            if (typeof console !== 'undefined' && console.error) {
              console.error('Log output error:', err);
            }
          });
        }
      } catch (err) {
        // Continue even if one output fails
        if (typeof console !== 'undefined' && console.error) {
          console.error('Log output error:', err);
        }
      }
    }
  }
  
  /**
   * Sanitize sensitive data from logs
   */
  private sanitize(data: any): any {
    if (!data) {
      return data;
    }
    
    // Handle arrays
    if (Array.isArray(data)) {
      return data.map(item => this.sanitize(item));
    }
    
    // Handle objects
    if (typeof data === 'object') {
      const sanitized: any = {};
      
      for (const [key, value] of Object.entries(data)) {
        const lowerKey = key.toLowerCase();
        
        // Sanitize sensitive keys
        if (
          lowerKey.includes('private') ||
          lowerKey.includes('key') ||
          lowerKey.includes('secret') ||
          lowerKey.includes('password') ||
          lowerKey.includes('token') ||
          lowerKey.includes('credential')
        ) {
          sanitized[key] = '[REDACTED]';
        } else {
          // Recursively sanitize nested objects
          sanitized[key] = this.sanitize(value);
        }
      }
      
      return sanitized;
    }
    
    // Return primitive values as-is
    return data;
  }
}

