import { OriginalsSDK } from '../index';

async function basicExample() {
  const sdk = OriginalsSDK.create({
    network: 'testnet',
    enableLogging: true,
    // Example uses defaults; provide adapters in your app or tests
    telemetry: {
      onEvent: (e) => console.log('[telemetry]', e.name, e.attributes || {}),
      onError: (err) => console.warn('[error]', err.code, err.message)
    }
  });

  // Create new digital asset
  const resources = [{
    id: 'image-1',
    type: 'image',
    content: 'base64-encoded-image-data',
    contentType: 'image/png',
    hash: 'sha256-hash'
  }];

  try {
    // Create asset in did:peer layer (private, offline)
    const asset = await sdk.lifecycle.createAsset(resources);
    console.log('Created asset:', asset.id);
    console.log('Current layer:', asset.currentLayer); // 'did:peer'
    
    // Publish to web for discovery (did:webvh layer)
    await sdk.lifecycle.publishToWeb(asset, 'example.com');
    console.log('Published to web, current layer:', asset.currentLayer); // 'did:webvh'
    
    // Inscribe on Bitcoin for permanent ownership (did:btco layer)
    await sdk.lifecycle.inscribeOnBitcoin(asset);
    console.log('Inscribed on Bitcoin, current layer:', asset.currentLayer); // 'did:btco'
    
    // Get full provenance chain
    const provenance = asset.getProvenance();
    console.log('Provenance:', provenance);
    
    // Verify asset integrity
    const isValid = await asset.verify();
    console.log('Asset is valid:', isValid);
    
  } catch (error) {
    console.error('Error:', error);
  }
}

async function digitalArtExample() {
  const sdk = OriginalsSDK.create();
  
  // Artist creates digital artwork
  const artwork = [{
    id: 'artwork-001',
    type: 'image', 
    url: 'https://artist-site.com/my-artwork.jpg',
    contentType: 'image/jpeg',
    hash: 'abcd1234...' // SHA-256 hash of image
  }];
  
  // Create private version for experimentation
  const asset = await sdk.lifecycle.createAsset(artwork);
  
  // Make discoverable when ready
  await sdk.lifecycle.publishToWeb(asset, 'artist-gallery.com');
  
  // Inscribe on Bitcoin when sold
  await sdk.lifecycle.inscribeOnBitcoin(asset);
  
  // Transfer to buyer
  await sdk.lifecycle.transferOwnership(asset, 'buyer-address');
}

// Export examples
export { basicExample, digitalArtExample };


