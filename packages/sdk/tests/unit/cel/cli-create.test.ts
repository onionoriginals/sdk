/**
 * CLI Create Command Tests
 * 
 * Tests for the originals-cel create command.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createCommand, CreateFlags } from '../../../src/cel/cli/create';
import { parseEventLogJson } from '../../../src/cel/serialization/json';
import { parseEventLogCbor } from '../../../src/cel/serialization/cbor';
import { multikey } from '../../../src/crypto/Multikey';

describe('CLI create command', () => {
  let tempDir: string;
  let testFilePath: string;
  let testKeyPath: string;
  
  beforeAll(async () => {
    // Create temp directory for test files
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cel-cli-test-'));
    
    // Create a test file
    testFilePath = path.join(tempDir, 'test-image.png');
    const testContent = Buffer.from('PNG test content', 'utf-8');
    fs.writeFileSync(testFilePath, testContent);
    
    // Create a test key file (generate a key pair)
    const ed25519 = await import('@noble/ed25519');
    const privateKeyBytes = ed25519.utils.randomPrivateKey();
    const privateKey = multikey.encodePrivateKey(privateKeyBytes as Uint8Array, 'Ed25519');
    
    testKeyPath = path.join(tempDir, 'test-key.txt');
    fs.writeFileSync(testKeyPath, privateKey);
  });
  
  afterAll(() => {
    // Clean up temp directory
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
  
  describe('argument validation', () => {
    it('returns error when --name is missing', async () => {
      const result = await createCommand({
        file: testFilePath,
      });
      
      expect(result.success).toBe(false);
      expect(result.message).toContain('--name is required');
    });
    
    it('returns error when --file is missing', async () => {
      const result = await createCommand({
        name: 'Test Asset',
      });
      
      expect(result.success).toBe(false);
      expect(result.message).toContain('--file is required');
    });
    
    it('returns error when file does not exist', async () => {
      const result = await createCommand({
        name: 'Test Asset',
        file: '/nonexistent/file.png',
      });
      
      expect(result.success).toBe(false);
      expect(result.message).toContain('File not found');
    });
    
    it('returns error for invalid --format value', async () => {
      const result = await createCommand({
        name: 'Test Asset',
        file: testFilePath,
        format: 'xml',
      });
      
      expect(result.success).toBe(false);
      expect(result.message).toContain('--format must be "json" or "cbor"');
    });
    
    it('returns error when key file does not exist', async () => {
      const result = await createCommand({
        name: 'Test Asset',
        file: testFilePath,
        key: '/nonexistent/key.txt',
      });
      
      expect(result.success).toBe(false);
      expect(result.message).toContain('Key file not found');
    });
  });
  
  describe('key generation', () => {
    it('generates new Ed25519 key pair when --key not provided', async () => {
      const outputPath = path.join(tempDir, 'gen-key-output.cel.json');
      
      const result = await createCommand({
        name: 'Test Asset',
        file: testFilePath,
        output: outputPath,
      });
      
      expect(result.success).toBe(true);
      expect(result.keyGenerated).toBe(true);
      expect(result.privateKey).toBeDefined();
      expect(result.publicKey).toBeDefined();
      
      // Validate key format
      expect(result.privateKey).toMatch(/^z[a-zA-Z0-9]+$/);
      expect(result.publicKey).toMatch(/^z[a-zA-Z0-9]+$/);
      
      // Validate keys are Ed25519
      const decoded = multikey.decodePrivateKey(result.privateKey!);
      expect(decoded.type).toBe('Ed25519');
    });
    
    it('uses provided key when --key is specified', async () => {
      const outputPath = path.join(tempDir, 'provided-key-output.cel.json');
      
      const result = await createCommand({
        name: 'Test Asset',
        file: testFilePath,
        key: testKeyPath,
        output: outputPath,
      });
      
      expect(result.success).toBe(true);
      expect(result.keyGenerated).toBe(false);
    });
    
    it('loads key from JSON format file', async () => {
      // Create a JSON key file
      const ed25519 = await import('@noble/ed25519');
      const privateKeyBytes = ed25519.utils.randomPrivateKey();
      const privateKey = multikey.encodePrivateKey(privateKeyBytes as Uint8Array, 'Ed25519');
      
      const jsonKeyPath = path.join(tempDir, 'test-key.json');
      fs.writeFileSync(jsonKeyPath, JSON.stringify({ privateKey }));
      
      const outputPath = path.join(tempDir, 'json-key-output.cel.json');
      
      const result = await createCommand({
        name: 'Test Asset',
        file: testFilePath,
        key: jsonKeyPath,
        output: outputPath,
      });
      
      expect(result.success).toBe(true);
      expect(result.keyGenerated).toBe(false);
    });
  });
  
  describe('JSON output', () => {
    it('creates valid CEL event log in JSON format', async () => {
      const outputPath = path.join(tempDir, 'json-output.cel.json');
      
      const result = await createCommand({
        name: 'Test JSON Asset',
        file: testFilePath,
        output: outputPath,
        format: 'json',
      });
      
      expect(result.success).toBe(true);
      expect(fs.existsSync(outputPath)).toBe(true);
      
      // Parse and validate the output
      const content = fs.readFileSync(outputPath, 'utf-8');
      const log = parseEventLogJson(content);
      
      expect(log.events).toHaveLength(1);
      expect(log.events[0].type).toBe('create');
      expect(log.events[0].proof).toHaveLength(1);
      
      // Validate asset data
      const data = log.events[0].data as any;
      expect(data.name).toBe('Test JSON Asset');
      expect(data.layer).toBe('peer');
      expect(data.did).toMatch(/^did:peer:/);
      expect(data.resources).toHaveLength(1);
      expect(data.resources[0].mediaType).toBe('image/png');
      expect(data.resources[0].digestMultibase).toBeDefined();
    });
    
    it('uses JSON format by default', async () => {
      const outputPath = path.join(tempDir, 'default-format.cel.json');
      
      const result = await createCommand({
        name: 'Default Format Asset',
        file: testFilePath,
        output: outputPath,
        // format not specified
      });
      
      expect(result.success).toBe(true);
      
      // Should be valid JSON
      const content = fs.readFileSync(outputPath, 'utf-8');
      expect(() => JSON.parse(content)).not.toThrow();
    });
  });
  
  describe('CBOR output', () => {
    it('creates valid CEL event log in CBOR format', async () => {
      const outputPath = path.join(tempDir, 'cbor-output.cel.cbor');
      
      const result = await createCommand({
        name: 'Test CBOR Asset',
        file: testFilePath,
        output: outputPath,
        format: 'cbor',
      });
      
      expect(result.success).toBe(true);
      expect(fs.existsSync(outputPath)).toBe(true);
      
      // Parse and validate the output
      const content = fs.readFileSync(outputPath);
      const log = parseEventLogCbor(new Uint8Array(content));
      
      expect(log.events).toHaveLength(1);
      expect(log.events[0].type).toBe('create');
      
      // Validate asset data
      const data = log.events[0].data as any;
      expect(data.name).toBe('Test CBOR Asset');
      expect(data.layer).toBe('peer');
    });
    
    it('CBOR output is smaller than JSON output', async () => {
      const jsonPath = path.join(tempDir, 'size-compare.cel.json');
      const cborPath = path.join(tempDir, 'size-compare.cel.cbor');
      
      // Create with JSON
      await createCommand({
        name: 'Size Test Asset',
        file: testFilePath,
        output: jsonPath,
        format: 'json',
        key: testKeyPath, // Use same key for fair comparison
      });
      
      // Create with CBOR
      await createCommand({
        name: 'Size Test Asset',
        file: testFilePath,
        output: cborPath,
        format: 'cbor',
        key: testKeyPath,
      });
      
      const jsonSize = fs.statSync(jsonPath).size;
      const cborSize = fs.statSync(cborPath).size;
      
      // CBOR should be smaller
      expect(cborSize).toBeLessThan(jsonSize);
    });
  });
  
  describe('MIME type detection', () => {
    it('detects PNG MIME type', async () => {
      const pngPath = path.join(tempDir, 'test.png');
      fs.writeFileSync(pngPath, 'test');
      
      const outputPath = path.join(tempDir, 'png-mime.cel.json');
      await createCommand({
        name: 'PNG Asset',
        file: pngPath,
        output: outputPath,
      });
      
      const content = fs.readFileSync(outputPath, 'utf-8');
      const log = parseEventLogJson(content);
      const data = log.events[0].data as any;
      
      expect(data.resources[0].mediaType).toBe('image/png');
    });
    
    it('detects JPEG MIME type', async () => {
      const jpgPath = path.join(tempDir, 'test.jpg');
      fs.writeFileSync(jpgPath, 'test');
      
      const outputPath = path.join(tempDir, 'jpg-mime.cel.json');
      await createCommand({
        name: 'JPEG Asset',
        file: jpgPath,
        output: outputPath,
      });
      
      const content = fs.readFileSync(outputPath, 'utf-8');
      const log = parseEventLogJson(content);
      const data = log.events[0].data as any;
      
      expect(data.resources[0].mediaType).toBe('image/jpeg');
    });
    
    it('uses octet-stream for unknown extensions', async () => {
      const unknownPath = path.join(tempDir, 'test.xyz');
      fs.writeFileSync(unknownPath, 'test');
      
      const outputPath = path.join(tempDir, 'unknown-mime.cel.json');
      await createCommand({
        name: 'Unknown Asset',
        file: unknownPath,
        output: outputPath,
      });
      
      const content = fs.readFileSync(outputPath, 'utf-8');
      const log = parseEventLogJson(content);
      const data = log.events[0].data as any;
      
      expect(data.resources[0].mediaType).toBe('application/octet-stream');
    });
  });
  
  describe('proof structure', () => {
    it('generates DataIntegrityProof with eddsa-jcs-2022 cryptosuite', async () => {
      const outputPath = path.join(tempDir, 'proof-test.cel.json');
      
      await createCommand({
        name: 'Proof Test Asset',
        file: testFilePath,
        output: outputPath,
      });
      
      const content = fs.readFileSync(outputPath, 'utf-8');
      const log = parseEventLogJson(content);
      const proof = log.events[0].proof[0];
      
      expect(proof.type).toBe('DataIntegrityProof');
      expect(proof.cryptosuite).toBe('eddsa-jcs-2022');
      expect(proof.proofPurpose).toBe('assertionMethod');
      expect(proof.verificationMethod).toMatch(/^did:key:/);
      expect(proof.proofValue).toMatch(/^z[a-zA-Z0-9]+$/);
      expect(proof.created).toBeDefined();
    });
  });
  
  describe('file output', () => {
    it('writes to --output file when specified', async () => {
      const outputPath = path.join(tempDir, 'explicit-output.cel.json');
      
      const result = await createCommand({
        name: 'Output Test Asset',
        file: testFilePath,
        output: outputPath,
      });
      
      expect(result.success).toBe(true);
      expect(fs.existsSync(outputPath)).toBe(true);
      
      const content = fs.readFileSync(outputPath, 'utf-8');
      expect(content.length).toBeGreaterThan(0);
    });
    
    it('handles output to nested directories', async () => {
      const nestedDir = path.join(tempDir, 'nested', 'dir');
      fs.mkdirSync(nestedDir, { recursive: true });
      const outputPath = path.join(nestedDir, 'output.cel.json');
      
      const result = await createCommand({
        name: 'Nested Output Asset',
        file: testFilePath,
        output: outputPath,
      });
      
      expect(result.success).toBe(true);
      expect(fs.existsSync(outputPath)).toBe(true);
    });
  });
});
