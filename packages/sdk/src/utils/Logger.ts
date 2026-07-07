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

import type { OriginalsConfig } from '../types/index.js';

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
  data?: unknown;
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
 * Memoized loader for node:fs/promises appendFile.
 *
 * Loaded lazily (and only once) inside the Node-only file-logging path so
 * that importing `@originals/sdk` — which re-exports Logger and constructs
 * it in OriginalsSDK — never evaluates a Node built-in at module load time.
 * Browser/edge bundlers therefore don't need to resolve `node:fs/promises`
 * unless FileLogOutput is actually used.
 */
type AppendFileFn = (typeof import('node:fs/promises'))['appendFile'];
let appendFilePromise: Promise<AppendFileFn> | null = null;
// Sync fs module, loaded together with the async one so the process 'exit'
// hook (which cannot await) can flush any trailing buffered lines.
let fsSyncModule: typeof import('node:fs') | null = null;
function loadAppendFile(): Promise<AppendFileFn> {
  if (!appendFilePromise) {
    appendFilePromise = import('node:fs/promises').then((fs) => fs.appendFile);
    void import('node:fs').then((fs) => { fsSyncModule = fs; }).catch(() => { /* sync exit flush unavailable */ });
  }
  return appendFilePromise;
}

/**
 * File log output implementation (async)
 *
 * Node/Bun only: lazily loads `node:fs/promises` on first flush.
 */
export class FileLogOutput implements LogOutput {
  private buffer: string[] = [];
  private flushTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly flushInterval = 1000; // Flush every 1 second
  private exitHooksInstalled = false;
  // Bound on lines retained across failed writes so an unwritable file
  // cannot grow the buffer without limit.
  private static readonly MAX_BUFFERED_LINES = 10_000;

  constructor(private filePath: string) {}

  write(entry: LogEntry): void {
    // Format as JSON line
    const line = JSON.stringify(entry) + '\n';
    this.buffer.push(line);
    this.installExitHooks();

    // Schedule flush
    if (!this.flushTimeout) {
      this.flushTimeout = setTimeout(() => {
        void this.flush();
      }, this.flushInterval);
    }
  }

  /**
   * Flush trailing buffered lines at process exit: without this, up to
   * flushInterval worth of the most recent (often most important) log lines
   * was always lost on shutdown (issue #352). Browser/edge runtimes have no
   * `process`, so this is a no-op there.
   */
  private installExitHooks(): void {
    if (this.exitHooksInstalled) return;
    const proc = (globalThis as { process?: { on?: (event: string, listener: () => void) => unknown } }).process;
    if (!proc || typeof proc.on !== 'function') return;
    this.exitHooksInstalled = true;
    // beforeExit can run async work; 'exit' cannot, so it uses the sync fs
    // module (loaded on first flush) as a last resort for hard exits.
    proc.on('beforeExit', () => { void this.flush(); });
    proc.on('exit', () => { this.flushSync(); });
  }

  private flushSync(): void {
    if (this.buffer.length === 0 || !fsSyncModule) return;
    try {
      fsSyncModule.appendFileSync(this.filePath, this.buffer.join(''), 'utf8');
      this.buffer = [];
    } catch {
      // best effort — the process is exiting
    }
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) {
      return;
    }

    // Snapshot and clear; on write failure the snapshot is restored so the
    // batch is retried on the next flush instead of silently dropped
    // (issue #352). Writes that arrive while the append is in flight land in
    // the fresh buffer and schedule their own flush.
    const lines = this.buffer;
    this.buffer = [];
    this.flushTimeout = null;

    try {
      // Append via node:fs/promises so file logging works under both Node and Bun.
      // appendFile creates the file if it does not exist and avoids the
      // read-whole-file-then-rewrite pattern. The module is imported lazily
      // (memoized) so non-Node bundles never evaluate it.
      const appendFile = await loadAppendFile();
      await appendFile(this.filePath, lines.join(''), 'utf8');
    } catch (err) {
      this.buffer = lines.concat(this.buffer).slice(-FileLogOutput.MAX_BUFFERED_LINES);
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
  debug(message: string, data?: unknown): void {
    this.log('debug', message, data);
  }

  /**
   * Log an info message
   */
  info(message: string, data?: unknown): void {
    this.log('info', message, data);
  }

  /**
   * Log a warning message
   */
  warn(message: string, data?: unknown): void {
    this.log('warn', message, data);
  }

  /**
   * Log an error message
   */
  error(message: string, error?: Error, data?: unknown): void {
    const errorData: unknown = error ? {
      ...(data && typeof data === 'object' ? data : {}),
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
    const newLogger = Object.create(Logger.prototype) as Logger;
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
  private log(level: LogLevel, message: string, data?: unknown, duration?: number): void {
    // Check if we should log this level
    if (Logger.LEVEL_PRIORITY[level] < Logger.LEVEL_PRIORITY[this.minLevel]) {
      return;
    }
    
    // Sanitize data if needed. Sanitization must never crash the calling SDK
    // operation: a pathological payload (e.g. exotic exotic proxies/getters)
    // degrades to a placeholder instead of throwing out of the log call
    // (issue #349).
    let sanitizedData: unknown;
    if (this.sanitizeLogs) {
      try {
        sanitizedData = this.sanitize(data, new WeakSet());
      } catch {
        sanitizedData = '[unsanitizable]';
      }
    } else {
      sanitizedData = data;
    }
    
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
   * Sanitize sensitive data from logs.
   *
   * Cycle-safe: circular references (common in HTTP client errors carrying
   * request/response cycles) are replaced with '[Circular]' instead of
   * recursing until the stack overflows (issue #349).
   */
  private sanitize(data: unknown, seen: WeakSet<object>): unknown {
    if (!data) {
      return data;
    }

    // Cycle guard for anything object-shaped (arrays included). `seen` tracks
    // the CURRENT traversal path (entries are removed on the way back up), so
    // only true cycles — not shared references — collapse to '[Circular]'.
    if (typeof data === 'object') {
      if (seen.has(data)) {
        return '[Circular]';
      }
      seen.add(data);
    }

    try {
      // Handle arrays
      if (Array.isArray(data)) {
        return data.map(item => this.sanitize(item, seen));
      }

      // Handle objects
      if (typeof data === 'object') {
        // Dates and byte arrays carry no key names to redact; flattening them
        // through Object.entries would reduce them to '{}' / index maps.
        if (data instanceof Date || data instanceof Uint8Array) {
          return data;
        }

        const sanitized: Record<string, unknown> = {};

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
            sanitized[key] = this.sanitize(value, seen);
          }
        }

        return sanitized;
      }

      // Return primitive values as-is
      return data;
    } finally {
      if (typeof data === 'object' && data !== null) {
        seen.delete(data);
      }
    }
  }
}

