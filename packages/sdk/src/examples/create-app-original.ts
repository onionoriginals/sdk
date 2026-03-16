/**
 * Example: Creating an App Original
 *
 * Demonstrates creating a typed App Original — an executable application
 * with runtime requirements, entrypoint, and platform metadata.
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
 * Create a CLI tool as an App Original
 */
async function createCliApp(): Promise<void> {
  console.log('=== Creating a CLI App Original ===\n');

  const sdk = OriginalsSDK.create({
    network: 'regtest',
    defaultKeyType: 'Ed25519',
    webvhNetwork: 'magby',
    ordinalsProvider: new OrdMockProvider(),
  });

  const appCode = `
#!/usr/bin/env node
/**
 * originals-hello - A simple CLI greeting tool
 */
const name = process.argv[2] || 'World';
console.log(\`Hello, \${name}! Welcome to Originals Protocol.\`);
`.trim();

  const readmeContent = `
# originals-hello

A simple CLI greeting tool built on the Originals Protocol.

## Usage

\`\`\`bash
originals-hello [name]
\`\`\`
`.trim();

  const resources = [
    {
      id: 'index.js',
      type: 'code',
      content: appCode,
      contentType: 'application/javascript',
      hash: computeHash(appCode),
      size: appCode.length,
    },
    {
      id: 'README.md',
      type: 'document',
      content: readmeContent,
      contentType: 'text/markdown',
      hash: computeHash(readmeContent),
      size: readmeContent.length,
    },
  ];

  const appAsset = await sdk.lifecycle.createTypedOriginal(
    OriginalKind.App,
    {
      kind: OriginalKind.App,
      name: 'originals-hello',
      version: '1.0.0',
      description: 'A simple CLI greeting tool built on Originals Protocol',
      resources,
      tags: ['cli', 'hello-world', 'demo'],
      author: { name: 'Originals Developer' },
      license: 'MIT',
      metadata: {
        runtime: 'node',
        entrypoint: 'index.js',
        minRuntimeVersion: '18.0.0',
        platforms: ['linux', 'darwin', 'windows'],
        commands: {
          hello: {
            description: 'Print a greeting',
            args: ['[name]'],
          },
        },
        permissions: ['stdout'],
      },
    }
  );

  console.log('Created App Original:');
  console.log(`  ID: ${appAsset.id}`);
  console.log(`  Layer: ${appAsset.currentLayer}`);
  console.log(`  Resources: ${appAsset.resources.length}`);
  console.log('');
}

/**
 * Create a web app with environment configuration
 */
async function createWebApp(): Promise<void> {
  console.log('=== Creating a Web App Original ===\n');

  const sdk = OriginalsSDK.create({
    network: 'regtest',
    defaultKeyType: 'Ed25519',
    ordinalsProvider: new OrdMockProvider(),
  });

  const htmlContent = `
<!DOCTYPE html>
<html>
<head><title>Originals Dashboard</title></head>
<body>
  <div id="app"></div>
  <script src="app.js"></script>
</body>
</html>
`.trim();

  const jsContent = `
document.getElementById('app').innerHTML = '<h1>Originals Dashboard</h1>';
`.trim();

  const resources = [
    {
      id: 'index.html',
      type: 'code',
      content: htmlContent,
      contentType: 'text/html',
      hash: computeHash(htmlContent),
      size: htmlContent.length,
    },
    {
      id: 'app.js',
      type: 'code',
      content: jsContent,
      contentType: 'application/javascript',
      hash: computeHash(jsContent),
      size: jsContent.length,
    },
  ];

  const webApp = await sdk.lifecycle.createTypedOriginal(
    OriginalKind.App,
    {
      kind: OriginalKind.App,
      name: 'originals-dashboard',
      version: '0.1.0',
      description: 'Web dashboard for viewing Originals assets',
      resources,
      tags: ['web', 'dashboard', 'ui'],
      license: 'MIT',
      metadata: {
        runtime: 'browser',
        entrypoint: 'index.html',
        platforms: ['web'],
        env: {
          API_URL: {
            description: 'Backend API endpoint',
            required: true,
          },
          NETWORK: {
            description: 'Bitcoin network to use',
            required: false,
            default: 'mainnet',
          },
        },
      },
    }
  );

  console.log('Created Web App Original:');
  console.log(`  ID: ${webApp.id}`);
  console.log(`  Layer: ${webApp.currentLayer}`);
  console.log('');
}

async function main(): Promise<void> {
  try {
    await createCliApp();
    await createWebApp();
    console.log('=== All App Examples Completed ===');
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

export { createCliApp, createWebApp, main };

if (require.main === module) {
  void main();
}
