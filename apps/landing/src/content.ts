/**
 * All copy for the Originals landing page lives in this file.
 * Edit text here; layout and behavior live in the components.
 */

export const site = {
  title: 'Originals SDK — Provenance that survives the internet',
  description:
    'Create, publish, and inscribe digital assets with cryptographically verifiable provenance. did:cel → did:webvh → did:btco.',
  /**
   * PLACEHOLDER — production URL, pending the hosting decision in issue #330.
   * This is the single constant to swap once the domain is chosen. It is
   * injected into index.html (canonical, og:url, og:image, twitter:image) at
   * build time; public/robots.txt and public/sitemap.xml must carry the same
   * origin — the build fails with a pointed error if they drift.
   */
  url: 'https://originals.example.com',
  tagline: 'Provenance that survives the internet.',
  ogImageAlt:
    'Generative orbital artwork beside the Originals wordmark and the tagline “Provenance that survives the internet.”',
  wordmark: 'Originals',
  github: 'https://github.com/onionoriginals/sdk',
  install: 'npm install @originals/sdk'
};

export const nav = {
  links: [
    { label: 'Why Originals', href: '#why' },
    { label: 'Try it', href: '#demo' },
    { label: 'Protocol', href: '#protocol' },
    { label: 'Developers', href: '#developers' }
  ],
  /** Interim target: points at the demo until the creator-app upload flow ships. */
  cta: { label: 'Start', href: '#demo' },
  github: { label: 'GitHub', href: 'https://github.com/onionoriginals/sdk' }
};

export const hero = {
  eyebrow: 'Anchored on Bitcoin · Yours even if we disappear',
  headline: 'Proof you made it. Carved into Bitcoin.',
  subhead:
    'The internet is perfect at copying and terrible at remembering. Originals fixes the remembering: every asset carries a signed, verifiable history of who made it, where it lives, and who owns it — from private draft to Bitcoin-anchored original.',
  /** Interim target: points at the demo until the creator-app upload flow ships. */
  primaryCta: { label: 'Make your first Original', href: '#demo' },
  exampleLink: { label: 'See one that already exists', href: '#example' },
  pipelineCaption:
    'One asset, three layers: private draft, public, inscribed on Bitcoin. Each step signed. The path only moves forward.'
};

export const layers = [
  {
    id: 'did:cel' as const,
    name: 'did:cel',
    title: 'Create',
    role: 'Private draft',
    blurb: 'Born offline as a signed event log. Free, instant, and invisible until you say otherwise.',
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
      body: 'Every asset is a signed event log of how it was made and published, and ownership settles directly on Bitcoin. Anyone can verify the whole chain — without trusting you, us, or any platform.'
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
    'Name a piece and your browser generates a one-of-a-kind artwork — a real SVG file. The real @originals/sdk then hashes its actual bytes, mints its identity, signs its credentials, and inscribes it. Bitcoin steps use the SDK’s built-in mock Ordinals provider, so there’s nothing to install and no wallet to connect.',
  consoleHint:
    'Skeptical? Open your devtools console — every SDK event is logged live.',
  form: {
    titleLabel: 'Asset title',
    titlePlaceholder: 'e.g. Genesis Artwork #001',
    defaultTitle: 'Genesis Artwork #001',
    mediumLabel: 'Medium',
    mediums: ['Artwork', 'Music', 'Writing', 'Photograph', 'Dataset'],
    regenerate: 'Regenerate',
    artHint: 'Generated in your browser from the title — its exact bytes are what get hashed and inscribed.'
  },
  steps: [
    {
      id: 'create',
      action: 'Create asset',
      pending: 'Creating…',
      title: 'Create',
      layer: 'did:cel',
      description:
        'Hashes the artwork’s bytes and mints its did:cel genesis — a signed event log, entirely in this tab, no server involved.'
    },
    {
      id: 'publish',
      action: 'Publish to web',
      pending: 'Publishing…',
      title: 'Publish',
      layer: 'did:webvh',
      description:
        'Migrates the asset to did:webvh and hosts the signed DID log at this origin — the SDK’s real resolver then fetches it back over HTTP(S).'
    },
    {
      id: 'inscribe',
      action: 'Inscribe on Bitcoin',
      pending: 'Inscribing…',
      title: 'Inscribe',
      layer: 'did:btco',
      description:
        'Coming soon: inscribe the published Original onto a satoshi as did:btco — real Bitcoin inscription lands once testnet4 ordinals support ships.'
    }
  ],
  revise: {
    heading: 'Edit it — the log keeps every version',
    body:
      'Change the title and the artwork is regenerated from it. Commit, and the SDK signs an update event chaining the new bytes to the version before them — plus one for the metadata that describes them. At did:cel that is free and offline; once published, the SDK hosts the new bytes before it signs, so the log never names a file this origin won’t serve. Old versions stay resolvable.',
    regenerateAction: 'Shuffle artwork',
    action: 'Commit update',
    pending: 'Signing update…',
    discard: 'Discard revision',
    unsignedBadge: 'not in the log yet',
    unsignedNote:
      'This edit is only in the browser. Commit it to add a signed update event — or discard it and keep the version you have.',
    versionLabel: 'artwork',
    committedNote:
      'Every revision is a signed event chained to the one before it — open the Event log to see them.',
    lockedNote:
      'Revising an inscribed asset writes a new inscription on its satoshi — a paid on-chain append, so the demo stops here.'
  },
  eventLog: {
    title: 'Event log',
    empty: 'Awaiting genesis event',
    emptyHint: 'Create an asset and its signed event log builds here, entry by entry.',
    emptyUpcoming: ['create', 'migrate', 'migrate'],
    sourceNote: 'The asset IS this log — signed by @originals/sdk in this browser tab',
    /** Each entry commits to the hash of the one before it. */
    chainLabel: 'previousEvent',
    genesisLabel: 'genesis · no parent',
    signedBy: 'signed by',
    unsigned: 'unsigned'
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
  resolved: {
    heading: 'did:webvh log — live at this origin',
    resolvedBadge: 'resolved ✓',
    pendingBadge: 'resolves in production',
    linkLabel: 'Open the signed DID log',
    note: 'The SDK’s real resolver fetched this over HTTP(S) — no mock. Open it: it’s the signed version history.'
  },
  inscribeGate: {
    signInPrompt: 'Sign in to inscribe on Bitcoin testnet4 — your own key signs it.',
    yourKeyNote: 'Your Turnkey key signs this inscription in your browser. The server never sees a private key; funding comes from a testnet4 faucet (worthless tBTC).',
    fundingLabel: 'Requesting testnet4 funding…',
    signingLabel: 'Signing the commit with your key…',
    explorerLabel: 'View the real transaction on mempool.space',
    faucetEmpty: 'The testnet4 faucet is temporarily out of funds — try again in a bit.',
    mockNote: 'Bitcoin inscription runs against a mock provider in this environment (no wallet, no chain). Deploy with a testnet4 endpoint + faucet to make it real.'
  },
  deposit: {
    heading: 'Fund your inscription',
    signInPrompt: 'Sign in to inscribe on Bitcoin — your own key signs it, your own BTC funds it.',
    sendPrefix: 'Send at least',
    sendSuffix: 'of BTC to your deposit address, in a single payment (the inscription spends one confirmed deposit). It’s yours: the change and the inscribed sat come back to it.',
    addressLabel: 'Your deposit address',
    waiting: 'Waiting for your deposit…',
    detected: 'Deposit detected — waiting for one confirmation.',
    ready: 'Deposit confirmed — ready to inscribe.',
    needed: 'No confirmed deposit covering the fee yet — send BTC to your deposit address and wait for one confirmation.',
    nonRefundable: 'Creator pays: the network fee is non-refundable. You own the keys, the change, and the inscribed sat — nothing is custodied.',
    addressPending: 'Checking your deposit address with the server…',
    networkMismatch:
      'This deploy is misconfigured: the app was built for a different Bitcoin network than the server is running. Inscribing is disabled until they match — no deposit address is shown, because funds sent to it could not be spent here.',
    yourKeyNote: 'Your Turnkey key signs this inscription in your browser; your own deposit pays the fee. The server never sees a private key.'
  },
  comingSoon: 'Coming soon — inscribing on Bitcoin (did:btco) is not enabled yet. Your Original is already real and resolvable as did:webvh.',
  reset: 'Start over with a new asset'
};

export const yourOriginals = {
  navLabel: 'Your Originals',
  heading: 'Your Originals',
  subhead:
    'Every piece you’ve created and published lives here — each a real, resolvable did:webvh with a signed version history hosted at this origin.',
  signedOut: 'Sign in to see the Originals saved to your account.',
  emptyTitle: 'No Originals yet.',
  emptyBody: 'Create and publish your first piece in the live demo — signed in, it’s saved right here.',
  emptyCta: 'Create your first Original',
  resolvedBadge: 'resolved ✓',
  pendingBadge: 'resolves in production',
  openLog: 'Open the signed DID log',
  createdLabel: 'Created',
  viewLabel: 'View provenance',
  inscribedBadge: 'inscribed ✓',
  inscriptionPendingBadge: 'inscription pending',
  finish: {
    heading: 'Unfinished inscription',
    body: 'A previous inscription was interrupted before it finished broadcasting. The signed transactions are safely stored — finish it now; nothing needs re-signing and no funds are lost.',
    cta: 'Finish inscription',
    busy: 'Finishing…',
    done: 'Inscription broadcast — it will confirm on-chain shortly.',
    failed: 'Could not finish the inscription — try again in a moment.',
  },
};

export const originalDetail = {
  backLabel: 'Your Originals',
  signedOut: 'Sign in to see this Original.',
  loading: 'Fetching the signed artifacts…',
  notFoundTitle: 'Not one of your Originals.',
  notFoundBody:
    'This page shows Originals saved to your account — this DID isn’t among them. It may belong to another account, or the link is stale.',
  notFoundCta: 'Back to Your Originals',
  createdLabel: 'Created',
  verifyingBadge: 'Verifying in your browser…',
  verifiedBadge: 'Verified in this tab',
  failedBadge: 'Verification incomplete',
  verifyNote:
    'These checks run locally, against the artifacts this Original hosts at this origin — not a database row.',
  checkLabels: {
    hash: 'Resource bytes match their declared sha-256',
    log: 'did:webvh log — SCID and Ed25519 proof chain verify',
    cel: 'CEL event chain verifies back to the did:cel genesis'
  },
  artifactsMissing:
    'The signed artifacts could not be fetched in this environment — they resolve at the production origin.',
  timeline: {
    eyebrow: 'Provenance',
    heading: 'How this Original came to be',
    subhead:
      'Every step is a signed event in the asset’s own cryptographic event log. The log — not this page — is the source of truth: anyone can fetch it and re-verify the chain.',
    steps: {
      create: {
        title: 'Created',
        blurb:
          'Born as a did:cel genesis — a signed event log minted in the browser, no server involved. The resource bytes were hashed and sealed into the very first event.'
      },
      publish: {
        title: 'Published',
        blurb:
          'Migrated to did:webvh: a signed version history went live at this origin, resolvable by anyone with the SDK — or curl.'
      },
      inscribe: {
        title: 'Inscribed',
        blurb:
          'The next step in the lifecycle: inscribing on a satoshi makes ownership transferable on Bitcoin — permanent, final, and platform-free.'
      }
    },
    upcomingLabel: 'Up next',
    proofLabel: 'Signed',
  },
  resources: {
    heading: 'Sealed resources',
    subhead:
      'The files hashed into the genesis event. Change a single byte anywhere and every verification on this page fails.',
    digestLabel: 'Digest',
    typeLabel: 'Type',
    openRaw: 'Open raw bytes'
  },
  identity: {
    heading: 'Identity on the open web',
    subhead:
      'The current DID document, derived from the signed version-history log — the same document the SDK’s resolver returns for this DID.',
    did: 'DID',
    scid: 'SCID',
    versions: 'Log entries',
    updated: 'Last updated',
    updateKey: 'Update key',
    signingKey: 'Signing key',
    documentToggle: 'View the resolved DID document'
  },
  artifacts: {
    heading: 'Raw artifacts',
    subhead:
      'Nothing hidden: these are the exact files the resolver fetches. Take them anywhere — the signatures travel with the bytes.',
    logLabel: 'did.jsonl — signed version history',
    celLabel: 'cel.json — cryptographic event log'
  },
  bitcoin: {
    heading: 'On Bitcoin',
    subhead:
      'This Original is inscribed on a satoshi — ownership is live sat control, transferable on Bitcoin without any platform.',
    didLabel: 'did:btco',
    inscriptionLabel: 'Inscription',
    satoshiLabel: 'Satoshi',
    txLabel: 'Reveal transaction',
    pendingBadge: 'awaiting confirmation',
    confirmedBadge: 'confirmed on-chain',
    explorerLabel: 'View on mempool.space'
  }
};

export const realExample = {
  id: 'example',
  eyebrow: 'A real Original',
  headline: 'Don’t take our word for it.',
  subhead:
    '“First Light” is a genuine Original, minted with this SDK: real keys, a real did:cel genesis event log, a did:webvh identity with a signed version history, and a signed publication credential. Your browser is re-verifying every signature right now — the checks below run locally, not on a server.',
  checkLabels: {
    hash: 'Artwork bytes match their declared sha-256',
    log: 'did:webvh log — SCID and Ed25519 proof chain verify',
    credential: 'Publication credential signature verifies'
  },
  pendingLabel: 'Verifying in your browser…',
  checkFailDetails: {
    log: 'DID log did not verify, or is not the identity this asset migrated to',
    credential: 'Credential signature did not verify, or attests a different identity'
  },
  verifiedBadge: 'Verified in this tab',
  failedBadge: 'Verification incomplete',
  failNote:
    'Some checks could not complete in this environment. The raw artifacts are in the repository — verify them yourself with the SDK.',
  artifactsLabel: 'Raw artifacts',
  artifactsHref:
    'https://github.com/onionoriginals/sdk/tree/main/apps/landing/public/example',
  fields: {
    identity: 'Identity',
    published: 'Published as',
    credential: 'Credential',
    issued: 'Issued'
  }
};

export const protocol = {
  id: 'protocol',
  eyebrow: 'The protocol',
  headline: 'Three layers. One direction.',
  subhead:
    'Assets migrate unidirectionally — did:cel → did:webvh → did:btco. Each migration is recorded and signed, so the full lineage travels with the asset.',
  migrationNote:
    'Unidirectional by design: an original can gain permanence, but its history can never be quietly rewritten.',
  columns: [
    {
      layer: 'did:cel',
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
  sdkNote:
    'Everything on this page — sealing, publishing, inscription, verification — is @originals/sdk, MIT licensed.',
  docsLink: {
    label: 'Quickstart and docs on GitHub',
    href: 'https://github.com/onionoriginals/sdk#readme'
  }
};

export const footer = {
  tagline: 'Provenance that survives the internet.',
  license: 'MIT licensed. Built by Aviary Tech.',
  bottomLeft: '© 2026 Aviary Tech · MIT License',
  bottomRight: 'did:cel → did:webvh → did:btco',
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
