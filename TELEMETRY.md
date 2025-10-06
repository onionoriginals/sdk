# Logging and Telemetry Guide

Complete guide to logging, metrics, and telemetry in the Originals SDK.

## Table of Contents

- [Overview](#overview)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Logger](#logger)
- [Metrics](#metrics)
- [Event Integration](#event-integration)
- [Best Practices](#best-practices)
- [Export Formats](#export-formats)
- [Performance](#performance)
- [Troubleshooting](#troubleshooting)

---

## Overview

The Originals SDK provides a comprehensive logging and telemetry system that helps you:

- **Monitor operations** - Track all asset lifecycle operations
- **Debug issues** - Detailed structured logs with context
- **Measure performance** - Built-in timing and metrics
- **Production observability** - Export metrics to monitoring systems
- **Track errors** - Error codes and error rates

### Key Features

✅ **Structured Logging** - JSON-friendly log entries with context  
✅ **Multiple Log Levels** - debug, info, warn, error  
✅ **Child Loggers** - Hierarchical context (e.g., SDK:Lifecycle:CreateAsset)  
✅ **Performance Timing** - Automatic operation duration tracking  
✅ **Metrics Collection** - Count operations, track performance, error rates  
✅ **Event Integration** - Automatic logging of lifecycle events  
✅ **Multiple Outputs** - Console, file, custom destinations  
✅ **Data Sanitization** - Automatically redact sensitive data  
✅ **Export Formats** - JSON and Prometheus formats  

---

## Quick Start

### Basic Configuration

```typescript
import { OriginalsSDK } from '@originals/sdk';

const sdk = OriginalsSDK.create({
  network: 'mainnet',
  defaultKeyType: 'ES256K',
  logging: {
    level: 'info',
    sanitizeLogs: true
  },
  metrics: {
    enabled: true
  }
});

// Logger is available on sdk.logger
sdk.logger.info('SDK initialized');

// Metrics are available on sdk.metrics
const metrics = sdk.metrics.getMetrics();
console.log('Assets created:', metrics.assetsCreated);
```

### Enable Debug Logging

```typescript
const sdk = OriginalsSDK.create({
  network: 'mainnet',
  defaultKeyType: 'ES256K',
  logging: {
    level: 'debug' // Enable debug logs
  }
});
```

---

## Configuration

### Logging Configuration

```typescript
interface LoggingConfig {
  level?: 'debug' | 'info' | 'warn' | 'error';
  outputs?: LogOutput[];
  includeTimestamps?: boolean;
  includeContext?: boolean;
  eventLogging?: EventLoggingConfig;
  sanitizeLogs?: boolean;
}
```

**Options:**

- **`level`** - Minimum log level to output (default: `'info'`)
- **`outputs`** - Array of log output destinations (default: console)
- **`includeTimestamps`** - Include ISO timestamps in logs (default: `true`)
- **`includeContext`** - Include logger context in logs (default: `true`)
- **`eventLogging`** - Configure event logging levels
- **`sanitizeLogs`** - Redact sensitive data like private keys (default: `true`)

### Metrics Configuration

```typescript
interface MetricsConfig {
  enabled?: boolean;
  exportFormat?: 'json' | 'prometheus';
  collectCache?: boolean;
}
```

**Options:**

- **`enabled`** - Enable metrics collection (default: `true`)
- **`exportFormat`** - Default export format (default: `'json'`)
- **`collectCache`** - Track cache hit/miss rates (default: `false`)

### Complete Configuration Example

```typescript
import { ConsoleLogOutput, FileLogOutput } from '@originals/sdk';

const sdk = OriginalsSDK.create({
  network: 'mainnet',
  defaultKeyType: 'ES256K',
  logging: {
    level: 'debug',
    outputs: [
      new ConsoleLogOutput(),
      new FileLogOutput('./logs/sdk.log')
    ],
    includeTimestamps: true,
    includeContext: true,
    sanitizeLogs: true,
    eventLogging: {
      'asset:created': 'info',
      'asset:migrated': 'info',
      'asset:transferred': 'info',
      'resource:published': 'debug',
      'credential:issued': 'debug'
    }
  },
  metrics: {
    enabled: true,
    exportFormat: 'prometheus'
  }
});
```

---

## Logger

### Basic Usage

```typescript
const sdk = OriginalsSDK.create({ /* config */ });

// Log at different levels
sdk.logger.debug('Debug information', { detail: 'value' });
sdk.logger.info('Operation successful');
sdk.logger.warn('Warning: rate limit approaching');
sdk.logger.error('Operation failed', error, { context: 'data' });
```

### Log Levels

Logs are filtered based on the configured minimum level:

| Level | Priority | When to Use |
|-------|----------|-------------|
| `debug` | 0 | Detailed diagnostic information |
| `info` | 1 | General informational messages |
| `warn` | 2 | Warning messages, potential issues |
| `error` | 3 | Error messages, operation failures |

**Example:**

```typescript
// With level: 'info'
sdk.logger.debug('Not shown'); // Filtered out
sdk.logger.info('Shown');      // ✓
sdk.logger.warn('Shown');      // ✓
sdk.logger.error('Shown');     // ✓
```

### Child Loggers

Create child loggers for hierarchical context:

```typescript
const lifecycleLogger = sdk.logger.child('Lifecycle');
lifecycleLogger.info('Processing asset'); 
// Context: "SDK:Lifecycle"

const operationLogger = lifecycleLogger.child('CreateAsset');
operationLogger.info('Creating asset');
// Context: "SDK:Lifecycle:CreateAsset"
```

### Performance Timing

Track operation duration automatically:

```typescript
async function performOperation() {
  const stopTimer = sdk.logger.startTimer('myOperation');
  
  try {
    // ... perform work ...
    await doSomething();
    
    stopTimer(); // Logs: "myOperation completed (123.45ms)"
  } catch (error) {
    stopTimer(); // Still logs duration even on error
    throw error;
  }
}
```

### Custom Log Outputs

#### Console Output (Default)

```typescript
import { ConsoleLogOutput } from '@originals/sdk';

const consoleOutput = new ConsoleLogOutput();
```

#### File Output

```typescript
import { FileLogOutput } from '@originals/sdk';

const fileOutput = new FileLogOutput('./logs/app.log');
```

#### Custom Output

```typescript
import type { LogOutput, LogEntry } from '@originals/sdk';

class CustomOutput implements LogOutput {
  async write(entry: LogEntry): Promise<void> {
    // Send to external service
    await fetch('https://logs.example.com', {
      method: 'POST',
      body: JSON.stringify(entry)
    });
  }
}

const sdk = OriginalsSDK.create({
  network: 'mainnet',
  defaultKeyType: 'ES256K',
  logging: {
    outputs: [new CustomOutput()]
  }
});
```

#### Multiple Outputs

```typescript
sdk.logger.addOutput(new FileLogOutput('./logs/debug.log'));
sdk.logger.addOutput(new CustomOutput());
```

### Data Sanitization

Automatically redacts sensitive information:

```typescript
sdk.logger.info('User operation', {
  username: 'alice',
  privateKey: 'z6Mk...', // Will be [REDACTED]
  operation: 'transfer'
});

// Logged as:
// {
//   username: 'alice',
//   privateKey: '[REDACTED]',
//   operation: 'transfer'
// }
```

**Sanitized keys:**
- `privateKey`, `private_key`
- `secret`, `secretKey`
- `password`, `pwd`
- `token`, `accessToken`
- `credential`, `credentials`
- Any key containing "key", "secret", "password", "token", "credential"

**Disable sanitization:**

```typescript
const sdk = OriginalsSDK.create({
  network: 'mainnet',
  defaultKeyType: 'ES256K',
  logging: {
    sanitizeLogs: false // Disable for development only!
  }
});
```

---

## Metrics

### Available Metrics

The SDK tracks comprehensive metrics automatically:

```typescript
interface Metrics {
  // Asset operations
  assetsCreated: number;
  assetsMigrated: Record<string, number>; // by layer transition
  assetsTransferred: number;
  
  // Operation performance
  operationTimes: Record<string, OperationMetrics>;
  
  // Error tracking
  errors: Record<string, number>; // by error code
  
  // Cache statistics (optional)
  cacheStats?: {
    hits: number;
    misses: number;
    hitRate: number;
  };
  
  // System metrics
  startTime: string;
  uptime: number; // milliseconds
}
```

### Reading Metrics

```typescript
// Get complete metrics snapshot
const metrics = sdk.metrics.getMetrics();

console.log('Assets created:', metrics.assetsCreated);
console.log('Migrations:', metrics.assetsMigrated);
console.log('Errors:', metrics.errors);

// Get specific operation metrics
const createMetrics = sdk.metrics.getOperationMetrics('createAsset');
console.log('Average duration:', createMetrics.avgTime, 'ms');
console.log('Error rate:', createMetrics.errorCount / createMetrics.count);
```

### Operation Metrics

Each operation tracks detailed statistics:

```typescript
interface OperationMetrics {
  count: number;        // Total operations
  totalTime: number;    // Total time (ms)
  avgTime: number;      // Average time (ms)
  minTime: number;      // Minimum time (ms)
  maxTime: number;      // Maximum time (ms)
  errorCount: number;   // Number of errors
}
```

### Asset Lifecycle Metrics

```typescript
const metrics = sdk.metrics.getMetrics();

// Asset creation count
console.log('Total assets created:', metrics.assetsCreated);

// Migration counts by layer transition
console.log('Peer → Web:', metrics.assetsMigrated['peer→webvh']);
console.log('Web → Bitcoin:', metrics.assetsMigrated['webvh→btco']);

// Transfer count
console.log('Total transfers:', metrics.assetsTransferred);
```

### Error Tracking

```typescript
const metrics = sdk.metrics.getMetrics();

// Error counts by code
console.log('Asset creation errors:', metrics.errors['ASSET_CREATION_FAILED']);
console.log('Inscription errors:', metrics.errors['INSCRIPTION_FAILED']);

// Calculate error rate
const createOp = sdk.metrics.getOperationMetrics('createAsset');
const errorRate = createOp.errorCount / createOp.count;
console.log('Error rate:', (errorRate * 100).toFixed(2), '%');
```

### Recording Custom Metrics

Access the MetricsCollector in your code:

```typescript
// Record custom operation
const complete = sdk.metrics.startOperation('myCustomOperation');

try {
  // ... perform work ...
  complete(true); // Success
} catch (error) {
  complete(false); // Failure
  sdk.metrics.recordError('MY_ERROR_CODE');
  throw error;
}

// Or record directly with duration
sdk.metrics.recordOperation('operation', 123.45, true);
```

### Resetting Metrics

```typescript
// Reset all metrics (useful for testing)
sdk.metrics.reset();
```

---

## Event Integration

The SDK automatically logs lifecycle events and extracts metrics from them.

### Event Logging Configuration

Configure which events to log and at what level:

```typescript
const sdk = OriginalsSDK.create({
  network: 'mainnet',
  defaultKeyType: 'ES256K',
  logging: {
    level: 'info',
    eventLogging: {
      'asset:created': 'info',
      'asset:migrated': 'info',
      'asset:transferred': 'warn',
      'resource:published': 'debug',
      'credential:issued': 'debug',
      'verification:completed': 'info'
    }
  }
});
```

### Disable Event Logging

```typescript
const sdk = OriginalsSDK.create({
  network: 'mainnet',
  defaultKeyType: 'ES256K',
  logging: {
    eventLogging: {
      'resource:published': false, // Disable specific event
      'credential:issued': false
    }
  }
});
```

### Automatic Metrics from Events

Events automatically update metrics:

- **`asset:created`** → `assetsCreated++`
- **`asset:migrated`** → `assetsMigrated[transition]++`
- **`asset:transferred`** → `assetsTransferred++`

```typescript
// Create an asset
const asset = await sdk.lifecycle.createAsset(resources);

// Metrics are automatically updated
const metrics = sdk.metrics.getMetrics();
console.log(metrics.assetsCreated); // 1
```

---

## Best Practices

### Production Configuration

```typescript
const sdk = OriginalsSDK.create({
  network: 'mainnet',
  defaultKeyType: 'ES256K',
  logging: {
    level: 'info', // Don't use 'debug' in production
    outputs: [
      new FileLogOutput('./logs/app.log'),
      new ExternalLogService() // Send to monitoring service
    ],
    sanitizeLogs: true, // Always sanitize in production
    eventLogging: {
      'asset:created': 'info',
      'asset:migrated': 'info',
      'asset:transferred': 'info'
    }
  },
  metrics: {
    enabled: true,
    exportFormat: 'prometheus'
  }
});
```

### Development Configuration

```typescript
const sdk = OriginalsSDK.create({
  network: 'testnet',
  defaultKeyType: 'ES256K',
  logging: {
    level: 'debug', // Verbose logging for development
    outputs: [new ConsoleLogOutput()],
    sanitizeLogs: false, // See full data during development
    eventLogging: {
      'asset:created': 'debug',
      'asset:migrated': 'debug',
      'asset:transferred': 'debug',
      'resource:published': 'debug',
      'credential:issued': 'debug'
    }
  }
});
```

### Structured Logging

Always include relevant context in logs:

```typescript
// ✅ Good - structured data
sdk.logger.info('Asset created', {
  assetId: asset.id,
  resourceCount: resources.length,
  layer: asset.currentLayer
});

// ❌ Avoid - unstructured string
sdk.logger.info(`Asset ${asset.id} created with ${resources.length} resources`);
```

### Error Handling

```typescript
try {
  const asset = await sdk.lifecycle.createAsset(resources);
  sdk.logger.info('Asset created successfully', { assetId: asset.id });
} catch (error) {
  sdk.logger.error('Asset creation failed', error as Error, {
    resourceCount: resources.length,
    attempt: retryCount
  });
  sdk.metrics.recordError('ASSET_CREATION_FAILED');
  throw error;
}
```

### Performance Monitoring

```typescript
async function complexOperation() {
  const stopTimer = sdk.logger.startTimer('complexOperation');
  const complete = sdk.metrics.startOperation('complexOperation');
  
  try {
    // Perform operation
    const result = await performWork();
    
    stopTimer();
    complete(true);
    
    sdk.logger.info('Operation completed', { resultSize: result.length });
    return result;
    
  } catch (error) {
    stopTimer();
    complete(false);
    
    sdk.logger.error('Operation failed', error as Error);
    sdk.metrics.recordError('OPERATION_FAILED');
    throw error;
  }
}
```

---

## Export Formats

### JSON Export

```typescript
const json = sdk.metrics.export('json');
console.log(json);
```

**Output:**

```json
{
  "assetsCreated": 42,
  "assetsMigrated": {
    "peer→webvh": 30,
    "webvh→btco": 12
  },
  "assetsTransferred": 8,
  "operationTimes": {
    "createAsset": {
      "count": 42,
      "totalTime": 5250.5,
      "avgTime": 125.0,
      "minTime": 95.2,
      "maxTime": 180.7,
      "errorCount": 2
    }
  },
  "errors": {
    "ASSET_CREATION_FAILED": 2,
    "INSCRIPTION_FAILED": 1
  },
  "startTime": "2025-10-06T12:00:00.000Z",
  "uptime": 3600000
}
```

### Prometheus Export

```typescript
const prometheus = sdk.metrics.export('prometheus');
console.log(prometheus);
```

**Output:**

```prometheus
# HELP originals_assets_created_total Total number of assets created
# TYPE originals_assets_created_total counter
originals_assets_created_total 42

# HELP originals_assets_migrated_total Total number of assets migrated by layer transition
# TYPE originals_assets_migrated_total counter
originals_assets_migrated_total{from="peer",to="webvh"} 30
originals_assets_migrated_total{from="webvh",to="btco"} 12

# HELP originals_operation_createAsset_total Total number of createAsset operations
# TYPE originals_operation_createAsset_total counter
originals_operation_createAsset_total 42

# HELP originals_operation_createAsset_duration_milliseconds Duration of createAsset operations
# TYPE originals_operation_createAsset_duration_milliseconds summary
originals_operation_createAsset_duration_milliseconds{quantile="0.0"} 95.2
originals_operation_createAsset_duration_milliseconds{quantile="0.5"} 125.0
originals_operation_createAsset_duration_milliseconds{quantile="1.0"} 180.7
originals_operation_createAsset_duration_milliseconds_sum 5250.5
originals_operation_createAsset_duration_milliseconds_count 42

# HELP originals_errors_total Total number of errors by code
# TYPE originals_errors_total counter
originals_errors_total{code="ASSET_CREATION_FAILED"} 2

# HELP originals_uptime_milliseconds SDK uptime in milliseconds
# TYPE originals_uptime_milliseconds gauge
originals_uptime_milliseconds 3600000
```

### Integration with Monitoring Systems

#### Prometheus + Grafana

```typescript
import express from 'express';

const app = express();

app.get('/metrics', (req, res) => {
  const metrics = sdk.metrics.export('prometheus');
  res.set('Content-Type', 'text/plain');
  res.send(metrics);
});

app.listen(9090);
```

#### DataDog

```typescript
import type { LogOutput, LogEntry } from '@originals/sdk';

class DataDogOutput implements LogOutput {
  async write(entry: LogEntry): Promise<void> {
    await fetch('https://http-intake.logs.datadoghq.com/v1/input', {
      method: 'POST',
      headers: {
        'DD-API-KEY': process.env.DATADOG_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        service: 'originals-sdk',
        level: entry.level,
        message: entry.message,
        ...entry.data
      })
    });
  }
}
```

#### CloudWatch

```typescript
import { CloudWatchLogs } from 'aws-sdk';

class CloudWatchOutput implements LogOutput {
  private client = new CloudWatchLogs();
  
  async write(entry: LogEntry): Promise<void> {
    await this.client.putLogEvents({
      logGroupName: '/originals-sdk',
      logStreamName: 'application',
      logEvents: [{
        timestamp: new Date(entry.timestamp).getTime(),
        message: JSON.stringify(entry)
      }]
    }).promise();
  }
}
```

---

## Performance

### Overhead Benchmarks

The telemetry system is designed for production use with minimal overhead:

| Operation | Average Time | Target |
|-----------|--------------|--------|
| Log entry (info) | ~0.3ms | <1ms |
| Log entry (filtered) | ~0.01ms | <0.1ms |
| Metrics recording | ~0.05ms | <0.1ms |
| Event logging | ~0.4ms | <0.5ms |
| Timer operation | ~0.3ms | <1ms |
| JSON export | ~10ms | <50ms |
| Prometheus export | ~30ms | <100ms |

### Memory Efficiency

- **Logger**: No memory leaks, logs are written immediately
- **Metrics**: Aggregate data only, not individual records
- **Events**: No event history stored, processed on-the-fly

### Performance Tips

1. **Use appropriate log levels** - Don't use `debug` in production
2. **Filter early** - Set `level` to filter before processing
3. **Batch metrics exports** - Export periodically, not per-operation
4. **Async outputs** - Use non-blocking log outputs for I/O
5. **Sanitization** - Keep enabled in production (minimal overhead)

---

## Troubleshooting

### Common Issues

#### Logs Not Appearing

**Problem**: Logs are not showing up

**Solutions**:
1. Check log level - ensure configured level includes your logs
2. Verify outputs are configured
3. Check console/file permissions

```typescript
// Verify configuration
console.log('Log level:', sdk.logger); // Should show logger instance
```

#### Memory Usage Growing

**Problem**: Application memory increasing over time

**Solutions**:
1. Don't store log entries in memory
2. Use appropriate log levels (avoid debug in production)
3. Ensure file outputs are flushing correctly

```typescript
// ✅ Good - logs are written immediately
sdk.logger.info('Message');

// ❌ Bad - storing logs in memory
const logs = [];
sdk.logger.addOutput({ 
  write: (entry) => logs.push(entry) // Memory leak!
});
```

#### Sensitive Data in Logs

**Problem**: Private keys visible in logs

**Solution**: Ensure sanitization is enabled

```typescript
const sdk = OriginalsSDK.create({
  network: 'mainnet',
  defaultKeyType: 'ES256K',
  logging: {
    sanitizeLogs: true // Must be true!
  }
});
```

#### Metrics Not Updating

**Problem**: Metrics show zero or outdated values

**Solutions**:
1. Ensure metrics are enabled
2. Check that operations are completing
3. Verify event integration is active

```typescript
const metrics = sdk.metrics.getMetrics();
console.log('Metrics:', JSON.stringify(metrics, null, 2));
```

### Debug Mode

Enable maximum verbosity for troubleshooting:

```typescript
const sdk = OriginalsSDK.create({
  network: 'testnet',
  defaultKeyType: 'ES256K',
  logging: {
    level: 'debug',
    outputs: [
      new ConsoleLogOutput(),
      new FileLogOutput('./debug.log')
    ],
    sanitizeLogs: false,
    includeTimestamps: true,
    includeContext: true,
    eventLogging: {
      'asset:created': 'debug',
      'asset:migrated': 'debug',
      'asset:transferred': 'debug',
      'resource:published': 'debug',
      'credential:issued': 'debug',
      'verification:completed': 'debug'
    }
  }
});
```

---

## API Reference

### Logger

```typescript
class Logger {
  debug(message: string, data?: any): void;
  info(message: string, data?: any): void;
  warn(message: string, data?: any): void;
  error(message: string, error?: Error, data?: any): void;
  
  startTimer(operation: string): () => void;
  child(context: string): Logger;
  setOutput(output: LogOutput): void;
  addOutput(output: LogOutput): void;
}
```

### MetricsCollector

```typescript
class MetricsCollector {
  recordOperation(operation: string, duration: number, success: boolean): void;
  startOperation(operation: string): (success?: boolean) => void;
  
  recordAssetCreated(): void;
  recordMigration(from: LayerType, to: LayerType): void;
  recordTransfer(): void;
  recordError(code: string, operation?: string): void;
  
  recordCacheHit(): void;
  recordCacheMiss(): void;
  
  getMetrics(): Metrics;
  getOperationMetrics(operation: string): OperationMetrics | null;
  
  reset(): void;
  export(format: 'json' | 'prometheus'): string;
}
```

---

## Examples

See the test files for comprehensive examples:

- **Unit Tests**: `tests/unit/utils/Logger.test.ts`, `tests/unit/utils/MetricsCollector.test.ts`
- **Integration Tests**: `tests/integration/TelemetryIntegration.test.ts`
- **Performance Tests**: `tests/performance/logging.perf.test.ts`

---

## Support

For questions or issues:
- **GitHub Issues**: [Report an issue](https://github.com/aviarytech/originals-sdk/issues)
- **Documentation**: [Full SDK docs](./README.md)
- **Events**: [Event system docs](./EVENTS.md)

---

**Telemetry system is production-ready! 📊**

