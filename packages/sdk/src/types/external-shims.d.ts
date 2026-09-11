declare module 'jsonld';
declare module 'b58';

// Global shims for non-DOM/node test environments
declare const global: Record<string, unknown> & typeof globalThis;
declare function setTimeout(handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]): number;

