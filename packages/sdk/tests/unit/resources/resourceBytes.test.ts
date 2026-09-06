import { expect, test } from 'bun:test';
import { ResourceManager } from '../../../src/resources/ResourceManager';

test('ResourceManager owns raw bytes and exports a JSON-safe legacy base64 snapshot', () => {
  const manager = new ResourceManager();
  const input = new Uint8Array([137, 0, 255, 1]);
  const resource = manager.createResource(input, { id: 'binary', type: 'image', contentType: 'image/png' });
  input.fill(0);
  expect(resource.content).toEqual(new Uint8Array([137, 0, 255, 1]));
  expect(resource.contentBase64).toBeUndefined();
  const snapshots = JSON.parse(JSON.stringify(manager.exportResources()));
  expect(snapshots[0].contentBase64).toBe('iQD/AQ==');
  expect(snapshots[0].content).toBeUndefined();
  const fresh = new ResourceManager();
  const restored = fresh.importResource(snapshots[0]);
  expect(restored.content).toEqual(resource.content);
  expect(fresh.validateResource(restored).valid).toBe(true);
  snapshots[0].contentBase64 = 'AAAAAA==';
  expect(() => new ResourceManager().importResource(snapshots[0])).toThrow(/hash mismatch/);
});
