/**
 * Example: Creating a Dataset Original
 *
 * Demonstrates creating a typed Dataset Original — a structured data
 * collection with schema, columns, and provenance metadata.
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
 * Create a CSV dataset with schema
 */
async function createCsvDataset(): Promise<void> {
  console.log('=== Creating a CSV Dataset Original ===\n');

  const sdk = OriginalsSDK.create({
    network: 'regtest',
    defaultKeyType: 'Ed25519',
    webvhNetwork: 'magby',
    ordinalsProvider: new OrdMockProvider(),
  });

  const csvContent = `city,country,population,latitude,longitude
Tokyo,Japan,13960000,35.6762,139.6503
Delhi,India,11030000,28.7041,77.1025
Shanghai,China,24870000,31.2304,121.4737
São Paulo,Brazil,12330000,-23.5505,-46.6333
Mumbai,India,12480000,19.0760,72.8777`;

  const resources = [
    {
      id: 'cities.csv',
      type: 'data',
      content: csvContent,
      contentType: 'text/csv',
      hash: computeHash(csvContent),
      size: csvContent.length,
    },
  ];

  const datasetAsset = await sdk.lifecycle.createTypedOriginal(
    OriginalKind.Dataset,
    {
      kind: OriginalKind.Dataset,
      name: 'world-cities',
      version: '2024.1.0',
      description: 'Population data for major world cities',
      resources,
      tags: ['geography', 'population', 'cities', 'demographics'],
      author: { name: 'Originals Data Team' },
      license: 'CC-BY-4.0',
      metadata: {
        format: 'csv',
        schema: {
          type: 'object',
          properties: {
            city: { type: 'string' },
            country: { type: 'string' },
            population: { type: 'integer' },
            latitude: { type: 'number' },
            longitude: { type: 'number' },
          },
          required: ['city', 'country', 'population'],
        },
        recordCount: 5,
        columns: [
          { name: 'city', type: 'string', description: 'City name' },
          { name: 'country', type: 'string', description: 'Country name' },
          { name: 'population', type: 'integer', description: 'City population' },
          { name: 'latitude', type: 'number', description: 'Latitude coordinate', nullable: false },
          { name: 'longitude', type: 'number', description: 'Longitude coordinate', nullable: false },
        ],
        source: {
          origin: 'United Nations Population Division',
          collectedAt: '2024-01-15T00:00:00Z',
          methodology: 'Census data aggregation',
        },
        statistics: {
          sizeBytes: csvContent.length,
        },
        privacy: 'public',
        updateFrequency: 'monthly',
      },
    }
  );

  console.log('Created Dataset Original:');
  console.log(`  ID: ${datasetAsset.id}`);
  console.log(`  Layer: ${datasetAsset.currentLayer}`);
  console.log(`  Resources: ${datasetAsset.resources.length}`);
  console.log('');
}

/**
 * Create a JSON dataset with nested schema
 */
async function createJsonDataset(): Promise<void> {
  console.log('=== Creating a JSON Dataset Original ===\n');

  const sdk = OriginalsSDK.create({
    network: 'regtest',
    defaultKeyType: 'Ed25519',
    ordinalsProvider: new OrdMockProvider(),
  });

  const jsonContent = JSON.stringify({
    records: [
      { id: 'btc', name: 'Bitcoin', symbol: 'BTC', category: 'cryptocurrency' },
      { id: 'eth', name: 'Ethereum', symbol: 'ETH', category: 'cryptocurrency' },
      { id: 'sol', name: 'Solana', symbol: 'SOL', category: 'cryptocurrency' },
    ],
  }, null, 2);

  const datasetAsset = await sdk.lifecycle.createTypedOriginal(
    OriginalKind.Dataset,
    {
      kind: OriginalKind.Dataset,
      name: 'crypto-assets',
      version: '1.0.0',
      description: 'Reference dataset of cryptocurrency assets',
      resources: [{
        id: 'assets.json',
        type: 'data',
        content: jsonContent,
        contentType: 'application/json',
        hash: computeHash(jsonContent),
        size: jsonContent.length,
      }],
      tags: ['crypto', 'reference-data', 'assets'],
      license: 'CC0-1.0',
      metadata: {
        format: 'json',
        schema: {
          type: 'object',
          properties: {
            records: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  symbol: { type: 'string' },
                  category: { type: 'string' },
                },
              },
            },
          },
        },
        recordCount: 3,
        privacy: 'public',
        updateFrequency: 'weekly',
      },
    }
  );

  console.log('Created JSON Dataset:');
  console.log(`  ID: ${datasetAsset.id}`);
  console.log(`  Layer: ${datasetAsset.currentLayer}`);
  console.log('');
}

async function main(): Promise<void> {
  try {
    await createCsvDataset();
    await createJsonDataset();
    console.log('=== All Dataset Examples Completed ===');
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

export { createCsvDataset, createJsonDataset, main };

if (require.main === module) {
  void main();
}
