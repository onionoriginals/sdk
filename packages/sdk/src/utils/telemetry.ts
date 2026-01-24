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

export class StructuredError extends Error {
  public readonly code: string;
  public readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'StructuredError';
    this.code = code;
    this.details = details;
  }
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

