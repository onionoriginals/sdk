/**
 * Telemetry hooks and the structured error type used at the SDK's public
 * seams. `StructuredError` is the one defined by `@originals/vh`, so errors
 * thrown by the protocol engine and by this SDK share a single class.
 */
import { StructuredError } from '@originals/vh';

export { StructuredError };

export type TelemetryLevel = 'debug' | 'info' | 'warn' | 'error';

export interface TelemetryEvent {
  name: string;
  level?: TelemetryLevel;
  attributes?: Record<string, unknown>;
}

export interface TelemetryHooks {
  onEvent?: (event: TelemetryEvent) => void;
  onError?: (error: StructuredError) => void;
}

export function emitTelemetry(hooks: TelemetryHooks | undefined, event: TelemetryEvent): void {
  if (hooks && typeof hooks.onEvent === 'function') {
    try {
      hooks.onEvent({ level: 'info', ...event });
    } catch (_err) {
      // Intentionally ignore errors in telemetry hooks
    }
  }
}

export function emitError(hooks: TelemetryHooks | undefined, error: StructuredError): void {
  if (hooks && typeof hooks.onError === 'function') {
    try {
      hooks.onError(error);
    } catch (_err) {
      // Intentionally ignore errors in telemetry hooks
    }
  }
}
