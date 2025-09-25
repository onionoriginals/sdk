import { describe, it, expect, beforeAll } from 'bun:test';
import {
  createInitialSelection,
  createLabelMapFunction,
  createShuffledIdLabelMapFunction,
  deskolemizeNQuads,
  jsonPointerToPaths,
  labelReplacementCanonicalizeJsonLd,
  labelReplacementCanonicalizeNQuads,
  relabelBlankNodes,
  selectCanonicalNQuads,
  selectJsonLd,
  selectPaths,
  skolemizeCompactJsonLd,
  skolemizeExpandedJsonLd,
  stripBlankNodePrefixes,
  toDeskolemizedNQuads
} from '../selective-disclosure';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { createDocumentLoader } from '../document-loader';


describe('Selective Disclosure Utils', () => {
  let mockDocumentLoader: any;

  beforeAll(() => {
    mockDocumentLoader = createDocumentLoader();
  });

  // Helper function tests
  describe('stripBlankNodePrefixes', () => {
    it('should strip _: prefix from blank node identifiers', () => {
      const input = new Map([
        ['_:b0', '_:c0'],
        ['_:b1', '_:c1']
      ]);
      const expected = new Map([
        ['b0', 'c0'],
        ['b1', 'c1']
      ]);
      expect(stripBlankNodePrefixes(input)).toEqual(expected);
    });

    it('should return original map if no blank node prefixes', () => {
      const input = new Map([['key1', 'value1']]);
      expect(stripBlankNodePrefixes(input)).toBe(input);
    });
  });

  describe('createShuffledIdLabelMapFunction', () => {
    it('should create a function that generates deterministic shuffled labels', () => {
      const hmacKey = new Uint8Array([1, 2, 3]);
      const hmacFn = (input: Uint8Array) => hmac(sha256, hmacKey, input);
      const labelMapFn = createShuffledIdLabelMapFunction(hmacFn);
      
      const input = new Map([['b0', 'c0'], ['b1', 'c1']]);
      const result = labelMapFn(input);
      
      expect(result.size).toBe(2);
      expect(result.get('b0')).toMatch(/^b\d+$/);
      expect(result.get('b1')).toMatch(/^b\d+$/);
    });
  });

  describe('createLabelMapFunction', () => {
    it('should create a function that maps identifiers using provided label map', () => {
      const labelMap = new Map([['c0', 'b0'], ['c1', 'b1']]);
      const labelMapFn = createLabelMapFunction(labelMap);
      
      const canonicalIdMap = new Map([['x0', 'c0'], ['x1', 'c1']]);
      const result = labelMapFn(canonicalIdMap);
      
      expect(result.get('x0')).toBe('b0');
      expect(result.get('x1')).toBe('b1');
    });
  });

  // Core functionality tests
  describe('jsonPointerToPaths', () => {
    it('should convert JSON pointer to path array', () => {
      expect(jsonPointerToPaths('/a/b/c')).toEqual(['a', 'b', 'c']);
      expect(jsonPointerToPaths('/0/1/2')).toEqual(['0', '1', '2']);
      expect(jsonPointerToPaths('/a~1b/c~0d')).toEqual(['a/b', 'c~d']);
    });
  });

  describe('createInitialSelection', () => {
    it('should create initial selection with @id and @type', () => {
      const source = {
        '@id': 'test:id',
        '@type': 'TestType',
        other: 'value'
      };
      expect(createInitialSelection(source)).toEqual({
        '@id': 'test:id',
        '@type': 'TestType'
      });
    });

    it('should handle blank node identifiers correctly', () => {
      const source = {
        '@id': '_:b0',
        '@type': 'TestType'
      };
      expect(createInitialSelection(source)).toEqual({
        '@type': 'TestType'
      });
    });
  });

  describe('skolemization and deskolemization', () => {

    describe('skolemizeExpandedJsonLd', () => {
      it('should skolemize expanded JSON-LD document', () => {
        const expanded = [{
          '@id': '_:b0',
          'ex:property': [{ '@value': 'test' }]
        }];
        
        const result = skolemizeExpandedJsonLd(expanded, {
          urnScheme: 'test',
          randomString: 'random',
          count: 0
        });

        expect(result[0]['@id']).toMatch(/^urn:test:/);
        expect(result[0]['ex:property']).toEqual([{ '@value': 'test' }]);
      });
    });

    describe('skolemizeCompactJsonLd', () => {
      it.only('should skolemize compact JSON-LD document', async () => {
        const document = {
          '@context': { 'ex': 'https://example.org/vocab#' },
          'ex:property': 'test'
        };

        const result = await skolemizeCompactJsonLd(
          document,
          'test',
          { documentLoader: mockDocumentLoader }
        );
        console.log(result.skolemizedCompactDocument['@id']);

        expect(result.skolemizedCompactDocument['@id']).toMatch(/^urn:test:/);
      });
    });

    describe('deskolemizeNQuads', () => {
      it('should convert URNs back to blank node identifiers', () => {
        const input = [
          '<urn:test:123> <p> <o> .\n',
          '<s> <p> <urn:test:456> .\n'
        ];
        const result = deskolemizeNQuads(input, 'test');
        expect(result[0]).toContain('_:123');
        expect(result[1]).toContain('_:456');
      });
    });
  });

  describe('selective disclosure', () => {
    const mockDocument = {
      '@context': { 'ex': 'https://example.org/vocab#' },
      '@id': 'test:id',
      'ex:mandatory': 'required',
      'ex:optional': 'optional'
    };

    describe('selectJsonLd', () => {
      it('should select portions of document using JSON pointers', () => {
        const pointers = ['/ex:mandatory'];
        const result = selectJsonLd(pointers, mockDocument);
        expect(result).toHaveProperty('ex:mandatory', 'required');
        expect(result).not.toHaveProperty('ex:optional');
      });
    });

    describe('selectPaths', () => {
      it('should select nested paths from document', () => {
        const document = { a: { b: { c: 'value' } } };
        const paths = ['a', 'b', 'c'];
        const selection = {};
        const arrays: any[] = [];
        
        selectPaths(document, paths, selection, arrays);
        expect(selection).toHaveProperty('a.b.c', 'value');
      });
    });
  });

  describe('canonicalization', () => {

    describe('labelReplacementCanonicalizeNQuads', () => {
      it('should canonicalize N-Quads and replace blank node identifiers', async () => {
        const nquads = [
          '_:b0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://www.w3.org/2018/credentials#VerifiableCredential> .\n',
          '_:b0 <https://www.w3.org/2018/credentials#credentialSubject> _:b1 .\n',
          '_:b1 <http://schema.org/name> "Alice Smith" .\n',
          '_:b1 <http://schema.org/birthDate> "1990-01-01" .\n'
        ];

        const hmacKey = new Uint8Array([1, 2, 3]);
        const hmacFn = (input: Uint8Array) => hmac(sha256, hmacKey, input);
        const labelMapFn = createShuffledIdLabelMapFunction(hmacFn);

        const result = await labelReplacementCanonicalizeNQuads(
          labelMapFn,
          nquads,
          { documentLoader: mockDocumentLoader }
        );

        // Check that all blank nodes were relabeled
        result.nquads.forEach(nquad => {
          expect(nquad).toMatch(/^(_:b\d+|<[^>]+>|"[^"]+"(\^\^<[^>]+>)?) /); // Subject
          expect(nquad).toMatch(/ <[^>]+> /); // Predicate
          expect(nquad).toMatch(/ (_:b\d+|<[^>]+>|"[^"]+"(\^\^<[^>]+>)?) \.\n$/); // Object
        });

        // Verify the structure is maintained
        expect(result.nquads.length).toBe(4);
        expect(result.labelMap.size).toBe(2); // Should have mappings for b0 and b1

        // Verify the relationships are preserved
        const [type, subject, name, birth] = result.nquads;
        const mainNode = type.match(/^(_:b\d+)/)?.[1];
        const subjectNode = subject.match(/ (_:b\d+) \.\n$/)?.[1];

        expect(mainNode).toBeDefined();
        expect(subjectNode).toBeDefined();
        expect(subject).toContain(mainNode); // Same subject as in type statement
        expect(name).toContain(subjectNode); // Same subject as credential subject
        expect(birth).toContain(subjectNode); // Same subject as credential subject
      });
    });

    describe('relabelBlankNodes', () => {
      it('should replace blank node identifiers using label map', () => {
        const labelMap = new Map([['b0', 'c0'], ['b1', 'c1']]);
        const nquads = ['_:b0 <p> _:b1 .\n'];
        
        const result = relabelBlankNodes(labelMap, nquads);
        expect(result[0]).toBe('_:c0 <p> _:c1 .\n');
      });
    });
  });
}); 