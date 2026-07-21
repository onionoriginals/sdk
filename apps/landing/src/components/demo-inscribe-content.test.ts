import { describe, test, expect } from 'bun:test';
import { demo } from '../content';

describe('demo inscribe-gate copy', () => {
  test('has an inscribeGate copy block', () => {
    expect(demo.inscribeGate).toBeDefined();
    expect(typeof demo.inscribeGate.signInPrompt).toBe('string');
    expect(demo.inscribeGate.signInPrompt.length).toBeGreaterThan(0);
    expect(typeof demo.inscribeGate.yourKeyNote).toBe('string');
    expect(typeof demo.inscribeGate.explorerLabel).toBe('string');
    expect(typeof demo.inscribeGate.faucetEmpty).toBe('string');
    expect(typeof demo.inscribeGate.mockNote).toBe('string');
  });
});
