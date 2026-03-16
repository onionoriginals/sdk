/**
 * Example: Creating an Agent Original
 *
 * Demonstrates creating a typed Agent Original — an AI agent or autonomous
 * system with capabilities, model info, tools, and memory configuration.
 */

import {
  OriginalsSDK,
  OriginalKind,
  OrdMockProvider,
} from '../index';
import { sha256 } from '@noble/hashes/sha2.js';

function computeHash(content: string): string {
  return Buffer.from(sha256(Buffer.from(content))).toString('hex');
}

/**
 * Create a code review AI agent
 */
async function createCodeReviewAgent(): Promise<void> {
  console.log('=== Creating a Code Review Agent Original ===\n');

  const sdk = OriginalsSDK.create({
    network: 'regtest',
    defaultKeyType: 'Ed25519',
    webvhNetwork: 'magby',
    ordinalsProvider: new OrdMockProvider(),
  });

  const systemPrompt = `
You are a code review agent. You analyze code for bugs, security issues,
and style violations. You provide actionable suggestions with specific
line references. You support TypeScript, JavaScript, Python, and Go.
`.trim();

  const resources = [
    {
      id: 'system-prompt.txt',
      type: 'text',
      content: systemPrompt,
      contentType: 'text/plain',
      hash: computeHash(systemPrompt),
      size: systemPrompt.length,
    },
  ];

  const agentAsset = await sdk.lifecycle.createTypedOriginal(
    OriginalKind.Agent,
    {
      kind: OriginalKind.Agent,
      name: 'code-reviewer',
      version: '1.0.0',
      description: 'AI agent that reviews code for bugs, security issues, and style',
      resources,
      tags: ['ai', 'code-review', 'security', 'linting'],
      author: { name: 'Originals AI Lab' },
      license: 'Apache-2.0',
      metadata: {
        capabilities: [
          'code-review',
          'bug-detection',
          'security-analysis',
          'style-checking',
        ],
        model: {
          provider: 'anthropic',
          name: 'claude-sonnet-4-6',
          version: '20250514',
        },
        inputTypes: ['text/plain', 'application/typescript', 'application/javascript', 'text/x-python'],
        outputTypes: ['application/json', 'text/markdown'],
        memory: {
          type: 'session',
          maxSize: 100000,
        },
        systemPrompt,
        tools: [
          {
            name: 'read_file',
            description: 'Read a file from the repository',
            parameters: { path: { type: 'string' } },
          },
          {
            name: 'search_code',
            description: 'Search for patterns in the codebase',
            parameters: { query: { type: 'string' }, glob: { type: 'string' } },
          },
        ],
        rateLimit: {
          requestsPerMinute: 30,
          tokensPerMinute: 100000,
        },
      },
    }
  );

  console.log('Created Agent Original:');
  console.log(`  ID: ${agentAsset.id}`);
  console.log(`  Layer: ${agentAsset.currentLayer}`);
  console.log(`  Resources: ${agentAsset.resources.length}`);
  console.log('');
}

/**
 * Create a stateless translation agent
 */
async function createTranslationAgent(): Promise<void> {
  console.log('=== Creating a Translation Agent Original ===\n');

  const sdk = OriginalsSDK.create({
    network: 'regtest',
    defaultKeyType: 'Ed25519',
    ordinalsProvider: new OrdMockProvider(),
  });

  const agentAsset = await sdk.lifecycle.createTypedOriginal(
    OriginalKind.Agent,
    {
      kind: OriginalKind.Agent,
      name: 'polyglot-translator',
      version: '1.0.0',
      description: 'Stateless translation agent supporting 50+ languages',
      resources: [{
        id: 'config.json',
        type: 'data',
        content: JSON.stringify({ supportedLanguages: ['en', 'es', 'fr', 'de', 'ja', 'zh', 'ko'] }),
        contentType: 'application/json',
        hash: computeHash('{}'),
        size: 80,
      }],
      tags: ['translation', 'nlp', 'multilingual'],
      license: 'MIT',
      metadata: {
        capabilities: ['translation', 'language-detection', 'transliteration'],
        model: {
          provider: 'anthropic',
          name: 'claude-haiku-4-5',
        },
        inputTypes: ['text/plain'],
        outputTypes: ['text/plain', 'application/json'],
        memory: {
          type: 'stateless',
        },
      },
    }
  );

  console.log('Created Translation Agent:');
  console.log(`  ID: ${agentAsset.id}`);
  console.log(`  Layer: ${agentAsset.currentLayer}`);
  console.log('');
}

async function main(): Promise<void> {
  try {
    await createCodeReviewAgent();
    await createTranslationAgent();
    console.log('=== All Agent Examples Completed ===');
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

export { createCodeReviewAgent, createTranslationAgent, main };

if (require.main === module) {
  void main();
}
