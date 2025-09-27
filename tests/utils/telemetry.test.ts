import { emitTelemetry, emitError, StructuredError } from '../../src/utils/telemetry';

describe('utils/telemetry', () => {
  test('emitTelemetry invokes onEvent with default level info', () => {
    const onEvent = jest.fn();
    emitTelemetry({ onEvent }, { name: 'event-1' });
    expect(onEvent).toHaveBeenCalledTimes(1);
    const arg = onEvent.mock.calls[0][0];
    expect(arg.name).toBe('event-1');
    expect(arg.level).toBe('info');
  });

  test('emitTelemetry respects provided level', () => {
    const onEvent = jest.fn();
    emitTelemetry({ onEvent }, { name: 'event-2', level: 'debug' });
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0][0].level).toBe('debug');
  });

  test('emitTelemetry is no-op when hooks missing or handler absent', () => {
    expect(() => emitTelemetry(undefined, { name: 'noop' })).not.toThrow();
    expect(() => emitTelemetry({}, { name: 'noop' })).not.toThrow();
  });

  test('emitTelemetry swallows handler exceptions', () => {
    const onEvent = jest.fn(() => { throw new Error('boom'); });
    expect(() => emitTelemetry({ onEvent }, { name: 'err' })).not.toThrow();
  });

  test('StructuredError holds code, message, and optional details', () => {
    const err = new StructuredError('E_TEST', 'message', { a: 1 });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('StructuredError');
    expect(err.code).toBe('E_TEST');
    expect(err.message).toBe('message');
    expect(err.details).toEqual({ a: 1 });
  });

  test('emitError calls onError and swallows handler exceptions', () => {
    const onErrorOk = jest.fn();
    const se = new StructuredError('E', 'm');
    emitError({ onError: onErrorOk }, se);
    expect(onErrorOk).toHaveBeenCalledWith(se);

    const onErrorThrow = jest.fn(() => { throw new Error('boom'); });
    expect(() => emitError({ onError: onErrorThrow }, se)).not.toThrow();
    expect(() => emitError(undefined, se)).not.toThrow();
    expect(() => emitError({}, se)).not.toThrow();
  });
});

