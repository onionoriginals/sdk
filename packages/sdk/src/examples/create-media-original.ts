/**
 * Example: Creating a Media Original
 *
 * Demonstrates creating typed Media Originals — images, audio, and video
 * with format-specific metadata like dimensions, duration, and codec info.
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
 * Create a digital artwork (image) Original
 */
async function createImageOriginal(): Promise<void> {
  console.log('=== Creating an Image Media Original ===\n');

  const sdk = OriginalsSDK.create({
    network: 'regtest',
    defaultKeyType: 'Ed25519',
    webvhNetwork: 'magby',
    ordinalsProvider: new OrdMockProvider(),
  });

  // In a real app, this would be actual image bytes
  const imageContent = 'base64-encoded-png-data-placeholder';

  const resources = [
    {
      id: 'artwork.png',
      type: 'image',
      content: imageContent,
      contentType: 'image/png',
      hash: computeHash(imageContent),
      size: 2048000, // ~2MB
    },
    {
      id: 'thumbnail.png',
      type: 'image',
      content: 'base64-thumbnail-data',
      contentType: 'image/png',
      hash: computeHash('base64-thumbnail-data'),
      size: 50000,
    },
  ];

  const mediaAsset = await sdk.lifecycle.createTypedOriginal(
    OriginalKind.Media,
    {
      kind: OriginalKind.Media,
      name: 'Sunset Over Mountains',
      version: '1.0.0',
      description: 'Digital artwork depicting a sunset over mountain ranges',
      resources,
      tags: ['art', 'landscape', 'digital-painting', 'sunset'],
      author: { name: 'Alice Artist', url: 'https://alice.example.com' },
      license: 'CC-BY-NC-4.0',
      metadata: {
        mediaType: 'image',
        mimeType: 'image/png',
        dimensions: {
          width: 3840,
          height: 2160,
          aspectRatio: '16:9',
        },
        colorSpace: 'sRGB',
        thumbnail: 'thumbnail.png',
        altText: 'A vivid digital painting of a sunset casting warm orange and purple hues over snow-capped mountains',
      },
    }
  );

  console.log('Created Image Original:');
  console.log(`  ID: ${mediaAsset.id}`);
  console.log(`  Layer: ${mediaAsset.currentLayer}`);
  console.log(`  Resources: ${mediaAsset.resources.length}`);
  console.log('');
}

/**
 * Create a music track (audio) Original
 */
async function createAudioOriginal(): Promise<void> {
  console.log('=== Creating an Audio Media Original ===\n');

  const sdk = OriginalsSDK.create({
    network: 'regtest',
    defaultKeyType: 'Ed25519',
    ordinalsProvider: new OrdMockProvider(),
  });

  const audioContent = 'base64-encoded-mp3-data-placeholder';

  const audioAsset = await sdk.lifecycle.createTypedOriginal(
    OriginalKind.Media,
    {
      kind: OriginalKind.Media,
      name: 'Digital Dawn',
      version: '1.0.0',
      description: 'Electronic ambient track',
      resources: [{
        id: 'track.mp3',
        type: 'audio',
        content: audioContent,
        contentType: 'audio/mpeg',
        hash: computeHash(audioContent),
        size: 5200000,
      }],
      tags: ['music', 'ambient', 'electronic'],
      author: { name: 'Bob Beats' },
      license: 'CC-BY-SA-4.0',
      metadata: {
        mediaType: 'audio',
        mimeType: 'audio/mpeg',
        duration: 245, // 4:05
        audioChannels: 2,
        sampleRate: 44100,
        codec: 'mp3',
        bitrate: 320,
      },
    }
  );

  console.log('Created Audio Original:');
  console.log(`  ID: ${audioAsset.id}`);
  console.log(`  Layer: ${audioAsset.currentLayer}`);
  console.log('');
}

/**
 * Create a short video Original
 */
async function createVideoOriginal(): Promise<void> {
  console.log('=== Creating a Video Media Original ===\n');

  const sdk = OriginalsSDK.create({
    network: 'regtest',
    defaultKeyType: 'Ed25519',
    ordinalsProvider: new OrdMockProvider(),
  });

  const videoContent = 'base64-encoded-mp4-data-placeholder';

  const videoAsset = await sdk.lifecycle.createTypedOriginal(
    OriginalKind.Media,
    {
      kind: OriginalKind.Media,
      name: 'Originals Protocol Explainer',
      version: '1.0.0',
      description: '60-second explainer video about the Originals Protocol',
      resources: [{
        id: 'explainer.mp4',
        type: 'video',
        content: videoContent,
        contentType: 'video/mp4',
        hash: computeHash(videoContent),
        size: 15000000,
      }],
      tags: ['video', 'explainer', 'originals', 'education'],
      author: { name: 'Originals Media Team' },
      license: 'CC-BY-4.0',
      metadata: {
        mediaType: 'video',
        mimeType: 'video/mp4',
        dimensions: {
          width: 1920,
          height: 1080,
          aspectRatio: '16:9',
        },
        duration: 60,
        frameRate: 30,
        audioChannels: 2,
        codec: 'h264',
        bitrate: 5000,
        caption: 'Originals Protocol enables verifiable digital asset provenance on Bitcoin.',
      },
    }
  );

  console.log('Created Video Original:');
  console.log(`  ID: ${videoAsset.id}`);
  console.log(`  Layer: ${videoAsset.currentLayer}`);
  console.log('');
}

async function main(): Promise<void> {
  try {
    await createImageOriginal();
    await createAudioOriginal();
    await createVideoOriginal();
    console.log('=== All Media Examples Completed ===');
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

export { createImageOriginal, createAudioOriginal, createVideoOriginal, main };

if (require.main === module) {
  void main();
}
