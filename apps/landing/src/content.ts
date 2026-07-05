/**
 * All copy for the Originals landing page lives in this file.
 * Edit text here; layout and behavior live in the components.
 */

export const site = {
  title: 'Originals SDK — Provenance that survives the internet',
  description:
    'Create, publish, and inscribe digital assets with cryptographically verifiable provenance. did:peer → did:webvh → did:btco.',
  wordmark: 'Originals',
  github: 'https://github.com/onionoriginals/sdk',
  install: 'npm install @originals/sdk'
};

export const nav = {
  links: [
    { label: 'Why Originals', href: '#why' },
    { label: 'Live demo', href: '#demo' },
    { label: 'Protocol', href: '#protocol' },
    { label: 'Developers', href: '#developers' }
  ],
  cta: { label: 'Get started', href: '#developers' },
  github: { label: 'GitHub', href: 'https://github.com/onionoriginals/sdk' }
};

export const hero = {
  eyebrow: 'Open protocol · W3C DIDs · Anchored on Bitcoin',
  headline: 'Proof of origin for every digital asset.',
  subhead:
    'The internet is perfect at copying and terrible at remembering. Originals fixes the remembering: every asset carries a signed, verifiable history of who made it, where it lives, and who owns it — from private draft to Bitcoin-anchored original.',
  primaryCta: { label: 'Run the live demo', href: '#demo' },
  installHint: 'or install the SDK',
  pipelineCaption: 'One asset, three layers. Migration is one-way: value moves up, history never rewrites.'
};

export const layers = [
  {
    id: 'did:peer' as const,
    name: 'did:peer',
    title: 'Create',
    role: 'Private draft',
    blurb: 'Born offline. Free, instant, and invisible until you say otherwise.',
    facts: ['Costs nothing', 'Works offline', 'Keys stay with you']
  },
  {
    id: 'did:webvh' as const,
    name: 'did:webvh',
    title: 'Publish',
    role: 'Public discovery',
    blurb: 'Hosted at your domain with a signed, append-only version history.',
    facts: ['Served over HTTPS', 'Versioned history', 'Resolvable by anyone']
  },
  {
    id: 'did:btco' as const,
    name: 'did:btco',
    title: 'Inscribe',
    role: 'Bitcoin ownership',
    blurb: 'Inscribed on a satoshi. Ownership becomes transferable and final.',
    facts: ['Anchored via Ordinals', 'Transferable', 'Outlives everything']
  }
];

export const why = {
  id: 'why',
  eyebrow: 'Why it matters',
  headline: 'The internet copies. Originals prove.',
  subhead:
    'Screenshots are free. Provenance is not. Originals gives digital work the one thing platforms can’t fake or take away: a cryptographic paper trail.',
  cards: [
    {
      title: 'Provenance you can hand to anyone',
      body: 'Every asset carries signed credentials for its creation, publication, and transfers. Anyone can verify the chain — without trusting you, us, or any platform.'
    },
    {
      title: 'A lifecycle, not a lock-in',
      body: 'Start private and free. Go public when it matters. Pay Bitcoin fees only when ownership is worth anchoring. Each step is optional, and the path only moves forward.'
    },
    {
      title: 'Rails that outlive companies',
      body: 'Built on W3C DIDs, Verifiable Credentials, and Bitcoin Ordinals. No proprietary registry, no token. If we vanish tomorrow, your provenance still verifies.'
    }
  ]
};

export const demo = {
  id: 'demo',
  eyebrow: 'Live demo',
  headline: 'Watch an original come to life.',
  subhead:
    'This is the real @originals/sdk running in your browser — real keys, real DIDs, real signatures, real events. Bitcoin steps use the SDK’s built-in mock Ordinals provider, so there’s nothing to install and no wallet to connect.',
  consoleHint:
    'Skeptical? Open your devtools console — every SDK event is logged live.',
  form: {
    titleLabel: 'Asset title',
    titlePlaceholder: 'e.g. Genesis Artwork #001',
    defaultTitle: 'Genesis Artwork #001',
    mediumLabel: 'Medium',
    mediums: ['Artwork', 'Music', 'Writing', 'Photograph', 'Dataset']
  },
  steps: [
    {
      id: 'create',
      action: 'Create asset',
      pending: 'Creating…',
      title: 'Create',
      layer: 'did:peer',
      description:
        'Hashes your content and mints a did:peer identity — entirely in this tab, no server involved.'
    },
    {
      id: 'publish',
      action: 'Publish to web',
      pending: 'Publishing…',
      title: 'Publish',
      layer: 'did:webvh',
      description:
        'Migrates the asset to did:webvh, publishes its resources, and signs a publication credential.'
    },
    {
      id: 'inscribe',
      action: 'Inscribe on Bitcoin',
      pending: 'Inscribing…',
      title: 'Inscribe',
      layer: 'did:btco',
      description:
        'Runs the commit/reveal inscription flow and binds the asset to a specific satoshi as did:btco.'
    }
  ],
  eventLog: {
    title: 'Event log',
    empty: 'Awaiting first event',
    emptyHint: 'Create an asset and real SDK events stream in here.',
    emptyUpcoming: ['asset:created', 'asset:migrated', 'credential:issued'],
    sourceNote: 'Emitted by @originals/sdk in this browser tab'
  },
  inspector: {
    provenanceTab: 'Provenance',
    resourceTab: 'Resource',
    emptyState: 'Create an asset to inspect its DID, hashes, and provenance chain.'
  },
  done: {
    lead: 'Anchored.',
    beforeSatoshi: 'Inscribed on satoshi',
    beforeTx: 'in tx',
    after: 'The full history is in the Provenance tab.'
  },
  reset: 'Start over with a new asset'
};

export const protocol = {
  id: 'protocol',
  eyebrow: 'The protocol',
  headline: 'Three layers. One direction.',
  subhead:
    'Assets migrate unidirectionally — did:peer → did:webvh → did:btco. Each migration is recorded and signed, so the full lineage travels with the asset.',
  migrationNote:
    'Unidirectional by design: an original can gain permanence, but its history can never be quietly rewritten.',
  columns: [
    {
      layer: 'did:peer',
      stage: '01 · Create',
      cost: 'Free',
      rows: [
        ['Where it lives', 'Your device'],
        ['Who can see it', 'Only you'],
        ['What it costs', 'Nothing'],
        ['Best for', 'Drafts, experiments, unreleased work']
      ]
    },
    {
      layer: 'did:webvh',
      stage: '02 · Publish',
      cost: 'Hosting',
      rows: [
        ['Where it lives', 'Your domain, over HTTPS'],
        ['Who can see it', 'Anyone — globally resolvable'],
        ['What it costs', 'Standard web hosting'],
        ['Best for', 'Catalogs, portfolios, discovery']
      ]
    },
    {
      layer: 'did:btco',
      stage: '03 · Inscribe',
      cost: 'BTC fees',
      rows: [
        ['Where it lives', 'A satoshi on Bitcoin'],
        ['Who can see it', 'Anyone, forever'],
        ['What it costs', 'One-time network fees'],
        ['Best for', 'Ownership, transfer, permanence']
      ]
    }
  ]
};

export const developers = {
  id: 'developers',
  eyebrow: 'Developers',
  headline: 'npm install to Bitcoin in one sitting.',
  subhead:
    'TypeScript-first, event-driven, and pluggable everywhere it counts: Ordinals providers, storage adapters, key stores, and external signers (Turnkey, AWS KMS, HSMs).',
  bullets: [
    'Typed events for every lifecycle step',
    'Mock Bitcoin provider for tests and CI',
    'External signers — keys never touch the SDK',
    'W3C Verifiable Credentials out of the box'
  ],
  installLabel: 'Install',
  quickstartLabel: 'Quickstart',
  quickstart: `import {
  OriginalsSDK,
  OrdMockProvider,
  MemoryStorageAdapter
} from '@originals/sdk';
import { sha256 } from '@noble/hashes/sha2.js';

// In-memory key store — swap for Turnkey, KMS, or your own
const keys = new Map<string, string>();
const keyStore = {
  getPrivateKey: async (id: string) => keys.get(id) ?? null,
  setPrivateKey: async (id: string, key: string) => {
    keys.set(id, key);
  }
};

// Mock Bitcoin provider — use OrdinalsClient in production
const sdk = OriginalsSDK.create({
  network: 'regtest',
  ordinalsProvider: new OrdMockProvider(),
  storageAdapter: new MemoryStorageAdapter(),
  keyStore
});

// 1 · Create a private did:peer asset — offline, free
const content = JSON.stringify({ title: 'Genesis #001' });
const hash = Buffer
  .from(sha256(Buffer.from(content)))
  .toString('hex');
const asset = await sdk.lifecycle.createAsset([{
  id: 'meta.json',
  type: 'data',
  content,
  contentType: 'application/json',
  hash,
  size: content.length
}]);

// 2 · Publish to did:webvh for public discovery
await sdk.lifecycle.publishToWeb(
  asset,
  'did:webvh:yourdomain.com:studio:you'
);

// 3 · Inscribe on Bitcoin as did:btco — ownership, anchored
await sdk.lifecycle.inscribeOnBitcoin(asset, 7);

// The signed history travels with the asset
console.log(asset.getProvenance());`,
  eventsLabel: 'Every step observable',
  eventsSnippet: `sdk.lifecycle.on('asset:migrated', (event) => {
  const { fromLayer, toLayer } = event.asset;
  console.log(fromLayer, '→', toLayer);
});`
};

export const footer = {
  tagline: 'Provenance that survives the internet.',
  license: 'MIT licensed. Built by Aviary Tech.',
  bottomLeft: '© 2026 Aviary Tech · MIT License',
  bottomRight: 'did:peer → did:webvh → did:btco',
  columns: [
    {
      title: 'Project',
      links: [
        { label: 'GitHub', href: 'https://github.com/onionoriginals/sdk' },
        { label: 'npm — @originals/sdk', href: 'https://www.npmjs.com/package/@originals/sdk' },
        { label: 'Protocol specification', href: 'https://github.com/onionoriginals/sdk/blob/main/ORIGINALS_PROTOCOL_SPECIFICATION.md' }
      ]
    },
    {
      title: 'Standards',
      links: [
        { label: 'W3C DID Core', href: 'https://www.w3.org/TR/did-core/' },
        { label: 'Verifiable Credentials', href: 'https://www.w3.org/TR/vc-data-model-2.0/' },
        { label: 'did:webvh method', href: 'https://identity.foundation/didwebvh/' }
      ]
    }
  ]
};
