/**
 * #596: a private draft must not leave the browser before the user chooses
 * Publish. `v3/LifecycleManager.createAsset()` and `OriginalsAsset` mutations
 * are in-memory only — this asserts that holds through the actual demo
 * engine, for both the anonymous and signed-in hosting adapters, and that
 * the first hosting write happens exactly at `publish()`.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { DemoEngine } from './engine';
import { installCel3Host, engineWithSigner } from './cel3-test-helpers';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>';
const SVG_V2 = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="8" height="8"/></svg>';

describe('no hosting write before Publish', () => {
  let host: ReturnType<typeof installCel3Host>;
  afterEach(() => host?.restore());

  test('anonymous create + edit makes no hosting request; Publish makes the first one', async () => {
    host = installCel3Host();
    const engine = new DemoEngine();

    await engine.create('Draft', 'Artwork', SVG);
    expect(host.writes).toEqual([]);

    await engine.update('Draft', 'Artwork', SVG_V2);
    expect(host.writes).toEqual([]);

    await engine.publish();
    expect(host.writes.length).toBeGreaterThan(0);
  });

  test('signed-in create + edit makes no hosting request; Publish makes the first one', async () => {
    host = installCel3Host('sub-1');
    const { engine } = engineWithSigner('sub-1');

    await engine.create('Draft', 'Artwork', SVG);
    expect(host.writes).toEqual([]);

    await engine.update('Draft', 'Artwork', SVG_V2);
    expect(host.writes).toEqual([]);

    await engine.publish();
    expect(host.writes.length).toBeGreaterThan(0);
  });
});
