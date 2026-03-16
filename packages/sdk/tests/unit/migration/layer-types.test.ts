import { describe, test, expect } from 'bun:test';
import { layerToLayerType, layerTypeToLayer, isDIDLayer } from '../../../src/migration/types';

describe('DIDLayer / LayerType conversion helpers', () => {
  describe('layerToLayerType', () => {
    test('converts peer to did:peer', () => {
      expect(layerToLayerType('peer')).toBe('did:peer');
    });

    test('converts webvh to did:webvh', () => {
      expect(layerToLayerType('webvh')).toBe('did:webvh');
    });

    test('converts btco to did:btco', () => {
      expect(layerToLayerType('btco')).toBe('did:btco');
    });

    test('throws on invalid DIDLayer', () => {
      // @ts-expect-error - testing invalid input
      expect(() => layerToLayerType('invalid')).toThrow("Invalid DIDLayer: 'invalid'");
    });

    test('throws on empty string', () => {
      // @ts-expect-error - testing invalid input
      expect(() => layerToLayerType('')).toThrow('Invalid DIDLayer');
    });
  });

  describe('layerTypeToLayer', () => {
    test('converts did:peer to peer', () => {
      expect(layerTypeToLayer('did:peer')).toBe('peer');
    });

    test('converts did:webvh to webvh', () => {
      expect(layerTypeToLayer('did:webvh')).toBe('webvh');
    });

    test('converts did:btco to btco', () => {
      expect(layerTypeToLayer('did:btco')).toBe('btco');
    });

    test('throws on invalid LayerType', () => {
      // @ts-expect-error - testing invalid input
      expect(() => layerTypeToLayer('did:web')).toThrow("Invalid LayerType: 'did:web'");
    });

    test('throws on short form (wrong function)', () => {
      // @ts-expect-error - testing invalid input
      expect(() => layerTypeToLayer('peer')).toThrow("Invalid LayerType: 'peer'");
    });
  });

  describe('isDIDLayer', () => {
    test('returns true for peer', () => {
      expect(isDIDLayer('peer')).toBe(true);
    });

    test('returns true for webvh', () => {
      expect(isDIDLayer('webvh')).toBe(true);
    });

    test('returns true for btco', () => {
      expect(isDIDLayer('btco')).toBe(true);
    });

    test('returns false for LayerType format', () => {
      expect(isDIDLayer('did:peer')).toBe(false);
    });

    test('returns false for arbitrary string', () => {
      expect(isDIDLayer('invalid')).toBe(false);
    });

    test('returns false for empty string', () => {
      expect(isDIDLayer('')).toBe(false);
    });
  });

  describe('roundtrip conversions', () => {
    const layers = ['peer', 'webvh', 'btco'] as const;

    for (const layer of layers) {
      test(`DIDLayer '${layer}' roundtrips through LayerType and back`, () => {
        const layerType = layerToLayerType(layer);
        const backToLayer = layerTypeToLayer(layerType);
        expect(backToLayer).toBe(layer);
      });
    }
  });
});
