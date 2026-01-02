/**
 * Example: Creating a Module Original
 * 
 * This example demonstrates how to create a typed Module Original using
 * the Originals SDK's Kind system. Module Originals are reusable code
 * packages with explicit exports, dependencies, and metadata.
 */

import { 
  OriginalsSDK, 
  OriginalKind, 
  OrdMockProvider,
  KindRegistry,
  type OriginalManifest
} from '../index';
import { sha256 } from '@noble/hashes/sha2.js';

/**
 * Helper to compute content hash
 */
function computeHash(content: string): string {
  return Buffer.from(sha256(Buffer.from(content))).toString('hex');
}

/**
 * Create a simple Module Original
 */
async function createSimpleModule(): Promise<void> {
  console.log('=== Creating a Simple Module Original ===\n');

  // Initialize SDK
  const sdk = OriginalsSDK.create({
    network: 'regtest',
    defaultKeyType: 'Ed25519',
    webvhNetwork: 'magby',
    ordinalsProvider: new OrdMockProvider(),
  });

  // Define module source code
  const moduleCode = `
/**
 * A simple greeting utility module
 */

/**
 * Generate a personalized greeting
 * @param name - The name to greet
 * @returns A friendly greeting string
 */
export function greet(name) {
  return \`Hello, \${name}! Welcome to Originals.\`;
}

/**
 * Generate a farewell message
 * @param name - The name to say goodbye to
 * @returns A farewell string
 */
export function farewell(name) {
  return \`Goodbye, \${name}! See you soon.\`;
}

/**
 * Get a random greeting from a list
 * @returns A random greeting string
 */
export function randomGreeting() {
  const greetings = ['Hey!', 'Hi there!', 'Howdy!', 'Welcome!', 'Greetings!'];
  return greetings[Math.floor(Math.random() * greetings.length)];
}
`.trim();

  // Define TypeScript type definitions
  const typeDefs = `
/**
 * Type definitions for greeting-utils module
 */

/**
 * Generate a personalized greeting
 */
export declare function greet(name: string): string;

/**
 * Generate a farewell message
 */
export declare function farewell(name: string): string;

/**
 * Get a random greeting from a list
 */
export declare function randomGreeting(): string;
`.trim();

  // Create resources
  const resources = [
    {
      id: 'index.js',
      type: 'code',
      content: moduleCode,
      contentType: 'application/javascript',
      hash: computeHash(moduleCode),
      size: moduleCode.length,
    },
    {
      id: 'index.d.ts',
      type: 'code',
      content: typeDefs,
      contentType: 'application/typescript',
      hash: computeHash(typeDefs),
      size: typeDefs.length,
    },
  ];

  // Create typed Module Original
  const moduleAsset = await sdk.lifecycle.createTypedOriginal(
    OriginalKind.Module,
    {
      kind: OriginalKind.Module,
      name: 'greeting-utils',
      version: '1.0.0',
      description: 'A simple greeting utility module for generating personalized messages',
      resources,
      tags: ['utility', 'greeting', 'message', 'text'],
      author: {
        name: 'Originals Developer',
        email: 'dev@originals.example',
      },
      license: 'MIT',
      homepage: 'https://github.com/originals/greeting-utils',
      metadata: {
        format: 'esm',
        main: 'index.js',
        types: 'index.d.ts',
        exports: {
          '.': {
            import: './index.js',
            types: './index.d.ts',
          },
        },
        sideEffects: false,
      },
    }
  );

  console.log('Created Module Original:');
  console.log(`  ID: ${moduleAsset.id}`);
  console.log(`  Layer: ${moduleAsset.currentLayer}`);
  console.log(`  Resources: ${moduleAsset.resources.length}`);
  console.log('');

  // Get the manifest back
  const manifest = sdk.lifecycle.getManifest(moduleAsset);
  if (manifest && manifest.metadata) {
    const meta = manifest.metadata as { format?: string; main?: string };
    console.log('Manifest details:');
    console.log(`  Name: ${manifest.name}`);
    console.log(`  Version: ${manifest.version}`);
    console.log(`  Format: ${meta.format}`);
    console.log(`  Main: ${meta.main}`);
  }
  console.log('');
}

/**
 * Create a Module Original with dependencies
 */
async function createModuleWithDependencies(): Promise<void> {
  console.log('=== Creating Module with Dependencies ===\n');

  const sdk = OriginalsSDK.create({
    network: 'regtest',
    defaultKeyType: 'Ed25519',
    ordinalsProvider: new OrdMockProvider(),
  });

  // Define module code that depends on another module
  const moduleCode = `
/**
 * Advanced formatter module that extends greeting-utils
 */
import { greet, farewell } from 'greeting-utils';

/**
 * Format a message with a timestamp
 * @param message - The message to format
 * @returns Formatted message with timestamp
 */
export function withTimestamp(message) {
  const now = new Date().toISOString();
  return \`[\${now}] \${message}\`;
}

/**
 * Create a welcome message with timestamp
 * @param name - The name to welcome
 * @returns Timestamped welcome message
 */
export function timedGreeting(name) {
  return withTimestamp(greet(name));
}

/**
 * Create a farewell message with timestamp
 * @param name - The name to say goodbye to
 * @returns Timestamped farewell message
 */
export function timedFarewell(name) {
  return withTimestamp(farewell(name));
}

/**
 * Format text with various styles
 * @param text - Text to format
 * @param style - Style option: 'upper' | 'lower' | 'title'
 */
export function formatText(text, style = 'title') {
  switch (style) {
    case 'upper': return text.toUpperCase();
    case 'lower': return text.toLowerCase();
    case 'title': return text.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    default: return text;
  }
}
`.trim();

  const moduleAsset = await sdk.lifecycle.createTypedOriginal(
    OriginalKind.Module,
    {
      kind: OriginalKind.Module,
      name: 'advanced-formatter',
      version: '1.0.0',
      description: 'Advanced text formatting utilities',
      resources: [{
        id: 'index.js',
        type: 'code',
        content: moduleCode,
        contentType: 'application/javascript',
        hash: computeHash(moduleCode),
        size: moduleCode.length,
      }],
      // Declare dependency on greeting-utils
      dependencies: [{
        did: 'did:peer:example-greeting-utils-did',
        name: 'greeting-utils',
        version: '^1.0.0',
      }],
      tags: ['formatter', 'text', 'utility'],
      license: 'MIT',
      metadata: {
        format: 'esm',
        main: 'index.js',
        peerDependencies: {
          'greeting-utils': '^1.0.0',
        },
      },
    }
  );

  console.log('Created Module with dependencies:');
  console.log(`  ID: ${moduleAsset.id}`);
  console.log(`  Dependencies: ${moduleAsset.resources.length > 0 ? 'greeting-utils ^1.0.0' : 'none'}`);
  console.log('');
}

/**
 * Validate a module manifest before creation
 */
function validateModuleManifest(): void {
  console.log('=== Validating Module Manifest ===\n');

  const registry = KindRegistry.getInstance();

  // Valid manifest
  const validManifest = {
    kind: OriginalKind.Module,
    name: 'my-module',
    version: '1.0.0',
    resources: [{
      id: 'index.js',
      type: 'code',
      contentType: 'application/javascript',
      hash: 'abc123',
    }],
    metadata: {
      format: 'esm' as const,
      main: 'index.js',
    },
  };

  const validResult = registry.validate(validManifest);
  console.log('Valid manifest result:', validResult.isValid ? 'VALID' : 'INVALID');
  if (validResult.warnings.length > 0) {
    console.log('Warnings:', validResult.warnings.map(w => w.message).join(', '));
  }
  console.log('');

  // Invalid manifest (missing required field)
  const invalidManifest = {
    kind: OriginalKind.Module,
    name: 'bad-module',
    version: '1.0.0',
    resources: [],
    metadata: {
      format: 'esm' as const,
      // Missing 'main' field!
    },
  };

  // Cast through unknown since this is intentionally invalid for testing validation
  const invalidResult = registry.validate(invalidManifest as unknown as OriginalManifest<OriginalKind.Module>);
  console.log('Invalid manifest result:', invalidResult.isValid ? 'VALID' : 'INVALID');
  if (!invalidResult.isValid) {
    console.log('Errors:');
    invalidResult.errors.forEach(e => {
      console.log(`  - [${e.code}] ${e.message}`);
    });
  }
  console.log('');
}

/**
 * Estimate costs for module inscription
 */
async function estimateModuleCosts(): Promise<void> {
  console.log('=== Estimating Module Inscription Costs ===\n');

  const sdk = OriginalsSDK.create({
    network: 'regtest',
    defaultKeyType: 'Ed25519',
    ordinalsProvider: new OrdMockProvider(),
  });

  const moduleCode = `export const VERSION = '1.0.0';`;

  const moduleAsset = await sdk.lifecycle.createTypedOriginal(
    OriginalKind.Module,
    {
      kind: OriginalKind.Module,
      name: 'tiny-module',
      version: '1.0.0',
      resources: [{
        id: 'index.js',
        type: 'code',
        content: moduleCode,
        contentType: 'application/javascript',
        hash: computeHash(moduleCode),
        size: moduleCode.length,
      }],
      metadata: {
        format: 'esm',
        main: 'index.js',
      },
    }
  );

  // Estimate costs at different fee rates
  const feeRates = [1, 5, 10, 20, 50];
  
  console.log('Cost estimates by fee rate:');
  for (const feeRate of feeRates) {
    const cost = await sdk.lifecycle.estimateCost(moduleAsset, 'did:btco', feeRate);
    console.log(`  ${feeRate} sat/vB: ${cost.totalSats} sats (~${(cost.totalSats / 100000000).toFixed(8)} BTC)`);
  }
  console.log('');

  // Validate migration before attempting
  const validation = await sdk.lifecycle.validateMigration(moduleAsset, 'did:btco');
  console.log('Migration validation:');
  console.log(`  Valid: ${validation.valid}`);
  console.log(`  Checks:`);
  Object.entries(validation.checks).forEach(([check, passed]) => {
    console.log(`    - ${check}: ${passed ? '✓' : '✗'}`);
  });
  console.log('');
}

/**
 * Create templates using KindRegistry
 */
function useModuleTemplates(): void {
  console.log('=== Using Module Templates ===\n');

  // Create a template for a Module
  const template = KindRegistry.createTemplate(OriginalKind.Module, 'my-new-module', '0.1.0');
  
  console.log('Module template:');
  console.log(JSON.stringify(template, null, 2));
  console.log('');

  // Parse kind from string
  const kindFromShort = KindRegistry.parseKind('module');
  const kindFromFull = KindRegistry.parseKind('originals:kind:module');
  
  console.log('Kind parsing:');
  console.log(`  'module' -> ${kindFromShort}`);
  console.log(`  'originals:kind:module' -> ${kindFromFull}`);
  console.log(`  Display name: ${KindRegistry.getDisplayName(OriginalKind.Module)}`);
  console.log(`  Short name: ${KindRegistry.getShortName(OriginalKind.Module)}`);
  console.log('');
}

/**
 * Main execution
 */
async function main(): Promise<void> {
  try {
    await createSimpleModule();
    await createModuleWithDependencies();
    validateModuleManifest();
    await estimateModuleCosts();
    useModuleTemplates();
    
    console.log('=== All Module Examples Completed ===');
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

// Export for use as module
export { 
  createSimpleModule, 
  createModuleWithDependencies,
  validateModuleManifest,
  estimateModuleCosts,
  useModuleTemplates,
  main 
};

// Run if executed directly
if (require.main === module) {
  void main();
}

