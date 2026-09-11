// Public-export regression for issue #597: the pre-CEL-3 layer managers
// must not be reachable from the package root, only from '@originals/cel/legacy'.
import { describe, test, expect } from 'bun:test';

describe('legacy layer manager export surface', () => {
  test('package root does not expose PeerCelManager/WebVHCelManager/BtcoCelManager', async () => {
    const root = await import('../../src/index.js');
    for (const legacyName of ['PeerCelManager', 'WebVHCelManager', 'BtcoCelManager']) {
      expect(Object.hasOwn(root, legacyName)).toBe(false);
    }
  });

  test('@originals/cel/legacy still exposes the retained layer managers', async () => {
    const legacy = await import('../../src/legacy.js');
    for (const legacyName of ['PeerCelManager', 'WebVHCelManager', 'BtcoCelManager']) {
      expect(Object.hasOwn(legacy, legacyName)).toBe(true);
      expect(typeof (legacy as Record<string, unknown>)[legacyName]).toBe('function');
    }
  });
});
