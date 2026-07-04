/**
 * Regression tests for MigrationManager singleton reconfiguration (issue #280)
 * and event subscription (issue #282).
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { MigrationManager } from '../../../src/migration/MigrationManager';
import { DIDManager } from '../../../src/did/DIDManager';
import { CredentialManager } from '../../../src/vc/CredentialManager';
import type { OriginalsConfig } from '../../../src/types';

const config: OriginalsConfig = {
  network: 'regtest',
  webvhNetwork: 'magby',
  defaultKeyType: 'Ed25519',
  enableLogging: false,
};

describe('MigrationManager singleton reconfiguration (issue #280)', () => {
  afterEach(() => MigrationManager.resetInstance());

  test('re-initializing with different dependencies throws instead of silently ignoring them', () => {
    const didManager = new DIDManager(config);
    const credentialManager = new CredentialManager(config, didManager);
    MigrationManager.getInstance(config, didManager, credentialManager);

    // A different config (e.g. a mainnet SDK) must not be silently discarded.
    const otherConfig: OriginalsConfig = { ...config, network: 'mainnet', webvhNetwork: 'pichu' };
    expect(() => MigrationManager.getInstance(otherConfig, didManager, credentialManager))
      .toThrow(/already initialized/i);
  });

  test('calling getInstance() with the same references is idempotent', () => {
    const didManager = new DIDManager(config);
    const credentialManager = new CredentialManager(config, didManager);
    const a = MigrationManager.getInstance(config, didManager, credentialManager);
    const b = MigrationManager.getInstance(config, didManager, credentialManager);
    expect(a).toBe(b);
  });

  test('calling getInstance() with no args returns the existing instance', () => {
    const didManager = new DIDManager(config);
    const credentialManager = new CredentialManager(config, didManager);
    const a = MigrationManager.getInstance(config, didManager, credentialManager);
    const b = MigrationManager.getInstance();
    expect(a).toBe(b);
  });

  test('resetInstance() allows deliberate reconfiguration', () => {
    const didManager = new DIDManager(config);
    const credentialManager = new CredentialManager(config, didManager);
    MigrationManager.getInstance(config, didManager, credentialManager);
    MigrationManager.resetInstance();

    const otherConfig: OriginalsConfig = { ...config, network: 'mainnet', webvhNetwork: 'pichu' };
    expect(() => MigrationManager.getInstance(otherConfig, didManager, credentialManager)).not.toThrow();
  });
});

describe('MigrationManager exposes event subscription (issue #282)', () => {
  afterEach(() => MigrationManager.resetInstance());

  test('on()/off() are available so migration events are observable', () => {
    const didManager = new DIDManager(config);
    const credentialManager = new CredentialManager(config, didManager);
    const mgr = MigrationManager.getInstance(config, didManager, credentialManager);

    expect(typeof mgr.on).toBe('function');
    expect(typeof mgr.off).toBe('function');
    expect(typeof mgr.once).toBe('function');

    let received = 0;
    const handler = () => { received++; };
    const unsubscribe = mgr.on('migration:quarantine', handler);
    // Subscribing returns an unsubscribe function.
    expect(typeof unsubscribe).toBe('function');
    unsubscribe();
    // After unsubscribing, off() is a no-op that does not throw.
    expect(() => mgr.off('migration:quarantine', handler)).not.toThrow();
    expect(received).toBe(0);
  });
});
