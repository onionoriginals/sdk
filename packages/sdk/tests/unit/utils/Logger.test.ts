import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger, ConsoleLogOutput, FileLogOutput, type LogEntry, type LogOutput } from '../../../src/utils/Logger';
import type { OriginalsConfig } from '../../../src/types';

describe('Logger', () => {
  let config: OriginalsConfig;
  
  beforeEach(() => {
    config = {
      network: 'mainnet',
      defaultKeyType: 'ES256K',
      logging: {
        level: 'info'
      }
    };
  });
  
  describe('log levels', () => {
    test('should log at debug level', () => {
      const output = mock(() => {});
      const mockOutput: LogOutput = {
        write: output
      };
      
      config.logging!.level = 'debug';
      config.logging!.outputs = [mockOutput];
      config.logging!.sanitizeLogs = false; // Disable sanitization for this test
      
      const logger = new Logger('Test', config);
      logger.debug('Debug message', { testField: 'value' });
      
      expect(output).toHaveBeenCalledTimes(1);
      const entry = output.mock.calls[0][0] as LogEntry;
      expect(entry.level).toBe('debug');
      expect(entry.message).toBe('Debug message');
      expect(entry.data).toEqual({ testField: 'value' });
    });
    
    test('should log at info level', () => {
      const output = mock(() => {});
      const mockOutput: LogOutput = {
        write: output
      };
      
      config.logging!.outputs = [mockOutput];
      
      const logger = new Logger('Test', config);
      logger.info('Info message');
      
      expect(output).toHaveBeenCalledTimes(1);
      const entry = output.mock.calls[0][0] as LogEntry;
      expect(entry.level).toBe('info');
      expect(entry.message).toBe('Info message');
    });
    
    test('should log at warn level', () => {
      const output = mock(() => {});
      const mockOutput: LogOutput = {
        write: output
      };
      
      config.logging!.outputs = [mockOutput];
      
      const logger = new Logger('Test', config);
      logger.warn('Warning message');
      
      expect(output).toHaveBeenCalledTimes(1);
      const entry = output.mock.calls[0][0] as LogEntry;
      expect(entry.level).toBe('warn');
      expect(entry.message).toBe('Warning message');
    });
    
    test('should log at error level with error object', () => {
      const output = mock(() => {});
      const mockOutput: LogOutput = {
        write: output
      };
      
      config.logging!.outputs = [mockOutput];
      
      const logger = new Logger('Test', config);
      const error = new Error('Test error');
      logger.error('Error occurred', error);
      
      expect(output).toHaveBeenCalledTimes(1);
      const entry = output.mock.calls[0][0] as LogEntry;
      expect(entry.level).toBe('error');
      expect(entry.message).toBe('Error occurred');
      expect(entry.data.error.message).toBe('Test error');
      expect(entry.data.error.name).toBe('Error');
    });
  });
  
  describe('log level filtering', () => {
    test('should filter out debug logs when level is info', () => {
      const output = mock(() => {});
      const mockOutput: LogOutput = {
        write: output
      };
      
      config.logging!.level = 'info';
      config.logging!.outputs = [mockOutput];
      
      const logger = new Logger('Test', config);
      logger.debug('Should not appear');
      logger.info('Should appear');
      
      expect(output).toHaveBeenCalledTimes(1);
      const entry = output.mock.calls[0][0] as LogEntry;
      expect(entry.level).toBe('info');
    });
    
    test('should filter out info and debug when level is warn', () => {
      const output = mock(() => {});
      const mockOutput: LogOutput = {
        write: output
      };
      
      config.logging!.level = 'warn';
      config.logging!.outputs = [mockOutput];
      
      const logger = new Logger('Test', config);
      logger.debug('Should not appear');
      logger.info('Should not appear');
      logger.warn('Should appear');
      logger.error('Should appear');
      
      expect(output).toHaveBeenCalledTimes(2);
    });
    
    test('should only log errors when level is error', () => {
      const output = mock(() => {});
      const mockOutput: LogOutput = {
        write: output
      };
      
      config.logging!.level = 'error';
      config.logging!.outputs = [mockOutput];
      
      const logger = new Logger('Test', config);
      logger.debug('Should not appear');
      logger.info('Should not appear');
      logger.warn('Should not appear');
      logger.error('Should appear');
      
      expect(output).toHaveBeenCalledTimes(1);
    });
  });
  
  describe('child loggers', () => {
    test('should create child logger with nested context', () => {
      const output = mock(() => {});
      const mockOutput: LogOutput = {
        write: output
      };
      
      config.logging!.outputs = [mockOutput];
      
      const parentLogger = new Logger('Parent', config);
      const childLogger = parentLogger.child('Child');
      
      childLogger.info('Message from child');
      
      expect(output).toHaveBeenCalledTimes(1);
      const entry = output.mock.calls[0][0] as LogEntry;
      expect(entry.context).toBe('Parent:Child');
    });
    
    test('should support multiple levels of nesting', () => {
      const output = mock(() => {});
      const mockOutput: LogOutput = {
        write: output
      };
      
      config.logging!.outputs = [mockOutput];
      
      const logger = new Logger('SDK', config);
      const child1 = logger.child('Lifecycle');
      const child2 = child1.child('CreateAsset');
      
      child2.info('Deeply nested message');
      
      expect(output).toHaveBeenCalledTimes(1);
      const entry = output.mock.calls[0][0] as LogEntry;
      expect(entry.context).toBe('SDK:Lifecycle:CreateAsset');
    });
    
    test('should inherit log level from parent', () => {
      const output = mock(() => {});
      const mockOutput: LogOutput = {
        write: output
      };
      
      config.logging!.level = 'warn';
      config.logging!.outputs = [mockOutput];
      
      const parentLogger = new Logger('Parent', config);
      const childLogger = parentLogger.child('Child');
      
      childLogger.info('Should not appear');
      childLogger.warn('Should appear');
      
      expect(output).toHaveBeenCalledTimes(1);
    });
  });
  
  describe('timer functionality', () => {
    test('should track operation duration', () => {
      const output = mock(() => {});
      const mockOutput: LogOutput = {
        write: output
      };
      
      config.logging!.level = 'debug';
      config.logging!.outputs = [mockOutput];
      
      const logger = new Logger('Test', config);
      const stopTimer = logger.startTimer('testOperation');
      
      // Simulate some work
      const start = Date.now();
      while (Date.now() - start < 10) {
        // Wait 10ms
      }
      
      stopTimer();
      
      expect(output).toHaveBeenCalledTimes(1);
      const entry = output.mock.calls[0][0] as LogEntry;
      expect(entry.duration).toBeDefined();
      expect(entry.duration!).toBeGreaterThanOrEqual(9); // Allow for timing variance
    });
    
    test('should log timer completion with operation name', () => {
      const output = mock(() => {});
      const mockOutput: LogOutput = {
        write: output
      };
      
      config.logging!.level = 'debug';
      config.logging!.outputs = [mockOutput];
      
      const logger = new Logger('Test', config);
      const stopTimer = logger.startTimer('myOperation');
      stopTimer();
      
      expect(output).toHaveBeenCalledTimes(1);
      const entry = output.mock.calls[0][0] as LogEntry;
      expect(entry.message).toBe('myOperation completed');
    });
  });
  
  describe('multiple outputs', () => {
    test('should write to multiple outputs', () => {
      const output1 = mock(() => {});
      const output2 = mock(() => {});
      
      const mockOutput1: LogOutput = { write: output1 };
      const mockOutput2: LogOutput = { write: output2 };
      
      config.logging!.outputs = [mockOutput1, mockOutput2];
      
      const logger = new Logger('Test', config);
      logger.info('Test message');
      
      expect(output1).toHaveBeenCalledTimes(1);
      expect(output2).toHaveBeenCalledTimes(1);
    });
    
    test('should continue if one output fails', () => {
      const output1 = mock(() => {
        throw new Error('Output 1 failed');
      });
      const output2 = mock(() => {});
      
      const mockOutput1: LogOutput = { write: output1 };
      const mockOutput2: LogOutput = { write: output2 };
      
      config.logging!.outputs = [mockOutput1, mockOutput2];
      
      const logger = new Logger('Test', config);
      
      // Should not throw
      expect(() => logger.info('Test message')).not.toThrow();
      
      // Both outputs should be called
      expect(output1).toHaveBeenCalledTimes(1);
      expect(output2).toHaveBeenCalledTimes(1);
    });
    
    test('should support addOutput to add additional outputs', () => {
      const output1 = mock(() => {});
      const output2 = mock(() => {});
      
      const mockOutput1: LogOutput = { write: output1 };
      const mockOutput2: LogOutput = { write: output2 };
      
      config.logging!.outputs = [mockOutput1];
      
      const logger = new Logger('Test', config);
      logger.addOutput(mockOutput2);
      
      logger.info('Test message');
      
      expect(output1).toHaveBeenCalledTimes(1);
      expect(output2).toHaveBeenCalledTimes(1);
    });
    
    test('should support setOutput to replace outputs', () => {
      const output1 = mock(() => {});
      const output2 = mock(() => {});
      
      const mockOutput1: LogOutput = { write: output1 };
      const mockOutput2: LogOutput = { write: output2 };
      
      config.logging!.outputs = [mockOutput1];
      
      const logger = new Logger('Test', config);
      logger.setOutput(mockOutput2);
      
      logger.info('Test message');
      
      expect(output1).not.toHaveBeenCalled();
      expect(output2).toHaveBeenCalledTimes(1);
    });
  });
  
  describe('data sanitization', () => {
    test('should sanitize private keys', () => {
      const output = mock(() => {});
      const mockOutput: LogOutput = {
        write: output
      };
      
      config.logging!.outputs = [mockOutput];
      config.logging!.sanitizeLogs = true;
      
      const logger = new Logger('Test', config);
      logger.info('User data', {
        username: 'alice',
        privateKey: 'z6Mk...',
        publicKey: 'z6Mk...'
      });
      
      expect(output).toHaveBeenCalledTimes(1);
      const entry = output.mock.calls[0][0] as LogEntry;
      expect(entry.data.username).toBe('alice');
      expect(entry.data.privateKey).toBe('[REDACTED]');
      expect(entry.data.publicKey).toBe('[REDACTED]');
    });
    
    test('should sanitize nested sensitive data', () => {
      const output = mock(() => {});
      const mockOutput: LogOutput = {
        write: output
      };
      
      config.logging!.outputs = [mockOutput];
      config.logging!.sanitizeLogs = true;
      
      const logger = new Logger('Test', config);
      logger.info('Nested data', {
        user: {
          name: 'alice',
          secret: 'top-secret',
          credentials: { token: 'abc123' }
        }
      });
      
      expect(output).toHaveBeenCalledTimes(1);
      const entry = output.mock.calls[0][0] as LogEntry;
      expect(entry.data.user.name).toBe('alice');
      expect(entry.data.user.secret).toBe('[REDACTED]');
      expect(entry.data.user.credentials).toBe('[REDACTED]');
    });
    
    test('should not sanitize when sanitizeLogs is false', () => {
      const output = mock(() => {});
      const mockOutput: LogOutput = {
        write: output
      };
      
      config.logging!.outputs = [mockOutput];
      config.logging!.sanitizeLogs = false;
      
      const logger = new Logger('Test', config);
      logger.info('User data', {
        privateKey: 'z6Mk...'
      });
      
      expect(output).toHaveBeenCalledTimes(1);
      const entry = output.mock.calls[0][0] as LogEntry;
      expect(entry.data.privateKey).toBe('z6Mk...');
    });
  });
  
  describe('ConsoleLogOutput', () => {
    test('should format log entries correctly', () => {
      const consoleOutput = new ConsoleLogOutput();
      const entry: LogEntry = {
        timestamp: '2025-10-06T12:00:00.000Z',
        level: 'info',
        context: 'Test',
        message: 'Test message',
        data: { key: 'value' }
      };
      
      // Should not throw
      expect(() => consoleOutput.write(entry)).not.toThrow();
    });
  });
  
  describe('performance', () => {
    test('should have minimal overhead (<1ms per log call)', () => {
      const output = mock(() => {});
      const mockOutput: LogOutput = {
        write: output
      };
      
      config.logging!.outputs = [mockOutput];
      
      const logger = new Logger('Test', config);
      
      const start = performance.now();
      for (let i = 0; i < 100; i++) {
        logger.info('Test message', { iteration: i });
      }
      const duration = performance.now() - start;
      
      const avgDuration = duration / 100;
      
      // Each log call should take less than 1ms on average
      expect(avgDuration).toBeLessThan(1);
    });
  });
  
  describe('configuration options', () => {
    test('should respect includeTimestamps option', () => {
      const output = mock(() => {});
      const mockOutput: LogOutput = {
        write: output
      };
      
      config.logging!.outputs = [mockOutput];
      config.logging!.includeTimestamps = false;
      
      const logger = new Logger('Test', config);
      logger.info('Test message');
      
      expect(output).toHaveBeenCalledTimes(1);
      const entry = output.mock.calls[0][0] as LogEntry;
      expect(entry.timestamp).toBe('');
    });
    
    test('should respect includeContext option', () => {
      const output = mock(() => {});
      const mockOutput: LogOutput = {
        write: output
      };
      
      config.logging!.outputs = [mockOutput];
      config.logging!.includeContext = false;
      
      const logger = new Logger('Test', config);
      logger.info('Test message');
      
      expect(output).toHaveBeenCalledTimes(1);
      const entry = output.mock.calls[0][0] as LogEntry;
      expect(entry.context).toBe('');
    });
  });

  describe('FileLogOutput', () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'originals-logger-test-'));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    const makeEntry = (message: string): LogEntry => ({
      timestamp: '2026-01-01T00:00:00.000Z',
      level: 'info',
      context: 'FileTest',
      message
    });

    test('creates the log file and writes entries as JSON lines (Node fs path)', async () => {
      const filePath = join(dir, 'app.log');
      const fileOutput = new FileLogOutput(filePath);

      fileOutput.write(makeEntry('first'));
      fileOutput.write(makeEntry('second'));
      // Flush buffered entries immediately instead of waiting for the timer
      await (fileOutput as unknown as { flush(): Promise<void> }).flush();

      const content = await readFile(filePath, 'utf8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).message).toBe('first');
      expect(JSON.parse(lines[1]).message).toBe('second');
    });

    test('appends to an existing file across flushes without clobbering', async () => {
      const filePath = join(dir, 'append.log');
      const fileOutput = new FileLogOutput(filePath);
      const flush = () => (fileOutput as unknown as { flush(): Promise<void> }).flush();

      fileOutput.write(makeEntry('one'));
      await flush();
      fileOutput.write(makeEntry('two'));
      await flush();
      fileOutput.write(makeEntry('three'));
      await flush();

      const content = await readFile(filePath, 'utf8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(3);
      expect(lines.map(l => JSON.parse(l).message)).toEqual(['one', 'two', 'three']);
    });

    test('flushes automatically via the timer after write()', async () => {
      const filePath = join(dir, 'timer.log');
      const fileOutput = new FileLogOutput(filePath);

      fileOutput.write(makeEntry('timed'));
      // Flush interval is 1 second; wait slightly longer
      await new Promise(resolve => setTimeout(resolve, 1200));

      const content = await readFile(filePath, 'utf8');
      expect(JSON.parse(content.trim()).message).toBe('timed');
    });
  });

  describe('bundler safety', () => {
    test('Logger module has no top-level node: imports (browser/edge bundle safe)', async () => {
      // Logger is re-exported from the SDK root and constructed by
      // OriginalsSDK, so any static `import ... from 'node:...'` here is
      // evaluated the moment `@originals/sdk` is imported and breaks
      // browser/edge bundles even when FileLogOutput is never used.
      // The fs dependency must be loaded lazily inside FileLogOutput.
      const loggerSourcePath = join(import.meta.dir, '../../../src/utils/Logger.ts');
      const source = await readFile(loggerSourcePath, 'utf8');
      expect(source).not.toMatch(/^\s*import\s[^;]*from\s+['"]node:/m);
      expect(source).not.toMatch(/^\s*import\s+['"]node:/m);
    });
  });
});


describe('Logger.sanitize cycle safety (issue #349)', () => {
  const makeConfig = (): OriginalsConfig => ({
    network: 'mainnet',
    defaultKeyType: 'ES256K',
    logging: { level: 'info', sanitizeLogs: true }
  });

  test('logging a circular object does not throw and marks the cycle', () => {
    const output = mock(() => {});
    const config = makeConfig();
    config.logging!.outputs = [{ write: output }];
    const logger = new Logger('Test', config);

    // Shape of a typical HTTP client error: request/response reference each other
    const request: Record<string, unknown> = { url: 'https://x' };
    const response: Record<string, unknown> = { status: 500, request };
    request.response = response;

    expect(() => logger.error('boom', undefined, { request })).not.toThrow();
    const entry = output.mock.calls[0][0] as LogEntry;
    const data = entry.data as { request: { response: { request: unknown } } };
    expect(data.request.response.request).toBe('[Circular]');
  });

  test('shared (non-circular) references are sanitized normally, not marked circular', () => {
    const output = mock(() => {});
    const config = makeConfig();
    config.logging!.outputs = [{ write: output }];
    const logger = new Logger('Test', config);

    const shared = { privateKey: 'z6Mk...', name: 'k' };
    logger.info('msg', { a: shared, b: shared });

    const entry = output.mock.calls[0][0] as LogEntry;
    const data = entry.data as { a: Record<string, unknown>; b: Record<string, unknown> };
    expect(data.a.privateKey).toBe('[REDACTED]');
    expect(data.b.privateKey).toBe('[REDACTED]');
  });

  test('Date and Uint8Array values pass through instead of flattening to {}', () => {
    const output = mock(() => {});
    const config = makeConfig();
    config.logging!.outputs = [{ write: output }];
    const logger = new Logger('Test', config);

    const when = new Date('2026-01-01T00:00:00Z');
    const bytes = new Uint8Array([1, 2, 3]);
    logger.info('msg', { when, bytes });

    const entry = output.mock.calls[0][0] as LogEntry;
    const data = entry.data as { when: unknown; bytes: unknown };
    expect(data.when).toBe(when);
    expect(data.bytes).toBe(bytes);
  });
});

describe('FileLogOutput write-failure retention (issue #352)', () => {
  test('a failed write retains the batch for the next flush instead of dropping it', async () => {
    const entry: LogEntry = {
      timestamp: '2026-01-01T00:00:00.000Z',
      level: 'info',
      context: 'RetentionTest',
      message: 'keep-me'
    };
    // A path whose parent directory does not exist makes appendFile fail.
    const badPath = join(tmpdir(), 'originals-logger-nonexistent-dir', 'deep', 'app.log');
    const fileOutput = new FileLogOutput(badPath);
    const internals = fileOutput as unknown as { buffer: string[]; flush(): Promise<void>; filePath: string };

    fileOutput.write(entry);
    await internals.flush();
    // The batch survived the failed write...
    expect(internals.buffer.length).toBe(1);
    expect(internals.buffer[0]).toContain('keep-me');

    // ...and lands in the file once the destination becomes writable.
    const dir = await mkdtemp(join(tmpdir(), 'originals-logger-retry-'));
    try {
      internals.filePath = join(dir, 'app.log');
      await internals.flush();
      const content = await readFile(join(dir, 'app.log'), 'utf8');
      expect(JSON.parse(content.trim()).message).toBe('keep-me');
      expect(internals.buffer.length).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
