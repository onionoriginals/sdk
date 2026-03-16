/**
 * Example: Creating a Document Original
 *
 * Demonstrates creating typed Document Originals — text documents with
 * format metadata, table of contents, word count, and references.
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
 * Create a technical whitepaper as a Document Original
 */
async function createWhitepaper(): Promise<void> {
  console.log('=== Creating a Whitepaper Document Original ===\n');

  const sdk = OriginalsSDK.create({
    network: 'regtest',
    defaultKeyType: 'Ed25519',
    webvhNetwork: 'magby',
    ordinalsProvider: new OrdMockProvider(),
  });

  const content = `
# Originals Protocol Whitepaper

## Abstract

The Originals Protocol provides a framework for creating, discovering,
and transferring digital assets with cryptographically verifiable provenance.
Built on three progressive DID layers, it enables creators to maintain
sovereignty over their digital works from creation through ownership transfer.

## 1. Introduction

Digital assets lack a standardized provenance chain. The Originals Protocol
solves this by linking asset creation to decentralized identifiers (DIDs)
across three trust layers.

## 2. Architecture

### 2.1 DID Layers

- **did:peer** — Private creation layer (offline, free)
- **did:webvh** — Public discovery via HTTPS hosting
- **did:btco** — Permanent ownership on Bitcoin

### 2.2 Migration Model

Assets migrate unidirectionally: peer → webvh → btco.

## 3. Conclusion

The Originals Protocol establishes verifiable provenance for digital assets
using progressive decentralization anchored to Bitcoin.
`.trim();

  const resources = [
    {
      id: 'whitepaper.md',
      type: 'document',
      content,
      contentType: 'text/markdown',
      hash: computeHash(content),
      size: content.length,
    },
  ];

  const docAsset = await sdk.lifecycle.createTypedOriginal(
    OriginalKind.Document,
    {
      kind: OriginalKind.Document,
      name: 'Originals Protocol Whitepaper',
      version: '1.0.0',
      description: 'Technical whitepaper describing the Originals Protocol architecture',
      resources,
      tags: ['whitepaper', 'protocol', 'technical', 'bitcoin'],
      author: { name: 'Originals Foundation' },
      license: 'CC-BY-4.0',
      metadata: {
        format: 'markdown',
        language: 'en',
        content: 'whitepaper.md',
        toc: [
          { title: 'Abstract', level: 2, anchor: 'abstract' },
          { title: '1. Introduction', level: 2, anchor: '1-introduction' },
          { title: '2. Architecture', level: 2, anchor: '2-architecture' },
          { title: '2.1 DID Layers', level: 3, anchor: '21-did-layers' },
          { title: '2.2 Migration Model', level: 3, anchor: '22-migration-model' },
          { title: '3. Conclusion', level: 2, anchor: '3-conclusion' },
        ],
        wordCount: 120,
        readingTime: 1,
        keywords: ['originals', 'protocol', 'DID', 'bitcoin', 'provenance'],
        abstract: 'The Originals Protocol provides a framework for creating, discovering, and transferring digital assets with cryptographically verifiable provenance.',
        status: 'published',
        revision: 1,
        references: [
          {
            id: 'did-core',
            title: 'Decentralized Identifiers (DIDs) v1.0',
            authors: ['Drummond Reed', 'Manu Sporny'],
            year: 2022,
            url: 'https://www.w3.org/TR/did-core/',
          },
          {
            id: 'ordinals',
            title: 'Ordinals Protocol',
            authors: ['Casey Rodarmor'],
            year: 2023,
            url: 'https://docs.ordinals.com/',
          },
        ],
      },
    }
  );

  console.log('Created Document Original:');
  console.log(`  ID: ${docAsset.id}`);
  console.log(`  Layer: ${docAsset.currentLayer}`);
  console.log(`  Resources: ${docAsset.resources.length}`);
  console.log('');
}

/**
 * Create a simple draft document
 */
async function createDraftDocument(): Promise<void> {
  console.log('=== Creating a Draft Document Original ===\n');

  const sdk = OriginalsSDK.create({
    network: 'regtest',
    defaultKeyType: 'Ed25519',
    ordinalsProvider: new OrdMockProvider(),
  });

  const content = 'This is a draft document being developed collaboratively.';

  const draftAsset = await sdk.lifecycle.createTypedOriginal(
    OriginalKind.Document,
    {
      kind: OriginalKind.Document,
      name: 'Project Proposal',
      version: '0.1.0',
      description: 'Initial draft of the project proposal',
      resources: [{
        id: 'proposal.txt',
        type: 'document',
        content,
        contentType: 'text/plain',
        hash: computeHash(content),
        size: content.length,
      }],
      tags: ['draft', 'proposal'],
      metadata: {
        format: 'txt',
        language: 'en',
        content: 'proposal.txt',
        wordCount: 9,
        status: 'draft',
        revision: 1,
      },
    }
  );

  console.log('Created Draft Document:');
  console.log(`  ID: ${draftAsset.id}`);
  console.log(`  Layer: ${draftAsset.currentLayer}`);
  console.log('');
}

async function main(): Promise<void> {
  try {
    await createWhitepaper();
    await createDraftDocument();
    console.log('=== All Document Examples Completed ===');
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

export { createWhitepaper, createDraftDocument, main };

if (require.main === module) {
  void main();
}
