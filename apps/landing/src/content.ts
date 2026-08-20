/**
 * All copy for the Originals landing page lives in this file.
 * Edit text here; layout and behavior live in the components.
 */

export const site = {
  title: 'Originals SDK — Provenance that survives the internet',
  description:
    'Create, publish, and inscribe digital assets with cryptographically verifiable provenance. did:cel → did:webvh → did:btco.',
  /**
   * The production origin. Single source of truth: injected into index.html
   * (canonical, og:url, og:image, twitter:image) at build time, and
   * public/robots.txt and public/sitemap.xml must carry the same origin —
   * the build fails with a pointed error if they drift.
   */
  url: 'https://originals.build',
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
  github: { label: 'GitHub', href: 'https://github.com/onionoriginals/sdk' },
  /** Composed with `site.wordmark` for the home link's accessible name. */
  homeAriaSuffix: '— home',
  primaryAria: 'Primary',
  mobileAria: 'Mobile',
  openMenu: 'Open menu',
  closeMenu: 'Close menu',
  signIn: 'Sign in',
  signOut: 'Sign out'
};

/** The email + OTP sign-in modal, and the code input inside it. */
export const login = {
  heading: 'Sign in',
  sub: 'We’ll email you a 6-digit code.',
  emailPlaceholder: 'you@example.com',
  close: 'Close',
  send: 'Send code',
  sending: 'Sending…',
  invalidEmail: 'Please enter a valid email address',
  sendFailed: 'Failed to send code',
  codeHeading: 'Enter your code',
  sentToPrefix: 'Sent to',
  verifyFailed: 'Verification failed',
  otp: {
    label: 'Verification code',
    /** Composed with the 1-based index: "Digit 3". */
    digitAriaPrefix: 'Digit',
    verifying: 'Verifying…',
    resend: 'Resend code',
    resendCooldownPrefix: 'Resend code in',
    resendCooldownSuffix: 's'
  }
};

/**
 * The signed-in hero panel. The DID it makes is signed by a browser-local
 * Ed25519 key and stored in localStorage (auth/webvh.ts) — created and shown,
 * never hosted. Nothing here may call it live, hosted or resolvable (R9).
 */
export const identityPanel = {
  layerLabel: 'did:webvh',
  idleTitle: 'Your own DID, signed in this browser',
  idleBody:
    'Mint a did:webvh signed by a key only this browser holds — yours to keep, and yours to sign your work with.',
  createAction: 'Create your did:webvh',
  creating: 'Creating…',
  createFailed: 'DID creation failed — try again.',
  doneTitle: 'Your DID is signed',
  doneNote:
    'Signed by a key this browser holds, and stored here beside it. It isn’t published anywhere yet, so nothing else can look it up — and clearing this browser’s storage takes the key with it.',
  copy: 'Copy',
  copied: 'Copied',
  copyAria: 'Copy DID',
  copiedAria: 'DID copied'
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
  /**
   * Tier-aware (R8). The old single subhead told everyone "Bitcoin steps use
   * the SDK's built-in mock Ordinals provider" — printed directly above what
   * is, for a signed-in visitor, a live mainnet money button. The lead is true
   * for both tiers; the tail states which of the two is reading it.
   */
  subhead:
    'Name a piece and your browser generates a one-of-a-kind artwork — a real SVG file. The real @originals/sdk then hashes its actual bytes, mints its identity, signs its credentials, and publishes it.',
  subheadReal:
    'The last step inscribes it on Bitcoin for real: your key signs the transactions in this browser, and your own BTC pays the network fee.',
  subheadSimulated:
    'The last step is a labelled simulation — the SDK’s built-in mock Ordinals provider stands in for the Bitcoin network, so there’s nothing to install and no wallet to connect.',
  /** Only appended where signing in genuinely buys a real inscription. */
  subheadSignIn: 'Sign in to inscribe for real, with your own key and your own BTC.',
  consoleHint:
    'Skeptical? Open your devtools console — every SDK event is logged live.',
  form: {
    titleLabel: 'Asset title',
    titlePlaceholder: 'e.g. Genesis Artwork #001',
    defaultTitle: 'Genesis Artwork #001',
    mediumLabel: 'Medium',
    mediums: ['Artwork', 'Music', 'Writing', 'Photograph', 'Dataset'],
    regenerate: 'Regenerate',
    artHint: 'Generated in your browser from the title — its exact bytes are what get hashed, signed and published.'
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
      // The signed-in mainnet tier. This step is LIVE: it spends the creator's
      // own confirmed deposit. The string it replaced ("Coming soon … once
      // testnet4 ordinals support ships") was wrong about the status and the
      // network, and rendered to every visitor regardless of tier.
      description:
        'Inscribes the published Original onto a satoshi as did:btco — real Bitcoin transactions, signed by your key in this browser and paid for out of your own deposit.'
    }
  ],
  /**
   * The simulated tier (R6). An anonymous visitor CAN complete step 3, so the
   * copy names it a simulation outright rather than promising a real
   * inscription later — the visual treatment carries the same signal.
   */
  simulated: {
    badge: 'simulated',
    action: 'Run the simulation',
    pending: 'Simulating…',
    description:
      'The SDK’s built-in mock Ordinals provider runs the commit/reveal flow right here in the tab — the same code path, standing in for the Bitcoin network.',
    note:
      'Nothing in this step reaches Bitcoin and no sats move: the satoshi and transaction id it produces come from the mock provider.'
  },
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
  /**
   * The completion screen, per tier (R8). Both halves used to be one block, so
   * a simulated run ended on "Anchored. Inscribed on satoshi <n> in tx <id>"
   * beside a mempool.space link — a specific fabricated claim about a specific
   * satoshi and a specific transaction, neither of which exists.
   */
  done: {
    real: {
      lead: 'Anchored on Bitcoin.',
      beforeSatoshi: 'Inscribed on satoshi',
      beforeTx: 'in transaction',
      after: 'The full history is in the Provenance tab.',
      explorerLabel: 'View the real transaction on mempool.space'
    },
    simulated: {
      lead: 'Simulation finished.',
      beforeSatoshi: 'The mock provider handed back satoshi',
      beforeTx: 'and transaction id',
      after:
        'Neither exists: nothing was broadcast and no sats moved. Everything before this step was real — the signed event log beside it is genuine, and only its Bitcoin anchor is make-believe.'
    }
  },
  resolved: {
    heading: 'did:webvh log — live at this origin',
    /** Anonymous logs live in the shared in-memory host store; see `hosting.temporaryNote`. */
    temporaryHeading: 'did:webvh log — served at this origin, for now',
    resolvedBadge: 'resolved ✓',
    pendingBadge: 'resolves in production',
    linkLabel: 'Open the signed DID log',
    note: 'The SDK’s real resolver fetched this back over HTTP(S). Open it: it’s the signed version history.'
  },
  /**
   * Reachable ONLY on a `VITE_BTC_NETWORK=testnet4` build (`real && network
   * !== 'mainnet'`): faucet-funded, worthless tBTC. Named for the network so
   * no mainnet surface can borrow a string from here by accident — the mainnet
   * copy lives in `steps[2]` and `deposit`.
   */
  testnet4: {
    signInPrompt: 'Sign in to inscribe on Bitcoin testnet4 — your own key signs it.',
    stepDescription:
      'Inscribes the published Original onto a satoshi as did:btco — a real inscription on Bitcoin testnet4, signed by your key and funded by a faucet with worthless tBTC.',
    yourKeyNote: 'Your Turnkey key signs this inscription in your browser. The server never sees a private key; funding comes from a testnet4 faucet (worthless tBTC).',
    faucetEmpty: 'The testnet4 faucet is temporarily out of funds — try again in a bit.',
    fundingFailed: 'The testnet4 funding request didn’t come through. Try the inscribe step again in a moment — nothing has been spent.'
  },
  session: {
    expiredHeading: 'Your signing session expired',
    expiredBody:
      'Your browser’s signing key has expired, so nothing can be signed right now. Sign in again to get a fresh one — your Original, and any BTC already sitting at your deposit address, are untouched and waiting.',
    missingBody:
      'You’re signed in, but this browser has no signing key for your account — sign in again to get one. Nothing is lost: your Original is still real and resolvable, and any BTC at your deposit address is still yours.',
    reauthCta: 'Sign in again to keep going',
    reauthPending: 'Waiting for you to sign back in…',
    preserved: 'Your Original is held right where you left it — signing back in picks up from here.',
    revokeFailed:
      'Signed out, and this browser’s signing key is erased. We couldn’t reach Turnkey to revoke it as well, so it stays valid there until it expires on its own.'
  },
  deposit: {
    heading: 'Fund your inscription',
    signInPrompt: 'Sign in to inscribe on Bitcoin — your own key signs it, your own BTC funds it.',
    sendPrefix: 'Send at least',
    sendSuffix: 'of BTC to your deposit address. One payment or several — the inscription spends every confirmed deposit sitting there, so a top-up after a fee rise works too. The change and the inscribed sat come back to the same address.',
    addressLabel: 'Your deposit address',
    waiting: 'Waiting for your deposit…',
    detected: 'Deposit detected — waiting for one confirmation.',
    ready: 'Deposit confirmed — ready to inscribe.',
    needed: 'No confirmed deposit covering the fee yet — send BTC to your deposit address and wait for one confirmation.',
    // U15 — the pre-deposit disclosure, rendered above the address in every
    // state (first visit, top-up, and a return visit where the address was
    // already issued). Mechanics only: who signs, where the key lives, what
    // happens to a balance that is never spent. The previous line here
    // ("You own the keys, the change, and the inscribed sat — nothing is
    // custodied") was a legal characterisation of a contested arrangement,
    // printed directly above the address a stranger sends mainnet BTC to.
    purpose:
      'This deposit funds one inscription: the Bitcoin network fees for its two transactions, plus the 546-sat output the inscription rides on. Whatever is left over comes back to the same address as change.',
    addressOrigin:
      'The address is derived in this browser from your Turnkey wallet, and your account is bound to the first address it sends us — we don’t re-check it against Turnkey after that. Your browser signs the spend with that wallet’s key; the key is never sent to the server.',
    nonRefundable:
      'The network fee is spent the moment the transactions are broadcast, and Bitcoin transactions cannot be reversed. Nobody — us included — can undo or refund one.',
    unspentBalance:
      'Anything you send that is never spent on an inscription stays sitting at that address. There is no withdraw or refund flow here: the only way to move it is to inscribe again through this site, for as long as this service and its Turnkey organization are running. Send the amount above rather than a round number you would want back.',
    // R31 — said BEFORE they deposit, because that is the only moment we are
    // sure they are reading. It names the exact place the state will be, so
    // "close the tab" is a safe thing to do rather than a gamble.
    ifSomethingGoesWrong:
      'You can close this tab. If anything goes wrong on our side while you’re away — we lose our read of the network, or your inscription stalls — it’ll be waiting for you on your Your Originals page the next time you sign in. We don’t send email about it, so that page is where to look.',
    addressPending: 'Checking your deposit address with the server…',
    unavailableBadge: 'Fee estimate unavailable.',
    readUnavailableBadge: 'Can’t read your deposit address.',
    readBusyBadge: 'Deposit lookups rate-limited.',
    feeUnavailable:
      'We can’t reach the Bitcoin fee estimator right now, so we can’t tell you an honest amount to deposit — and we won’t guess, because a wrong number would leave your BTC stuck in an inscription that can’t be paid for. No deposit address is shown until the estimate is back. Nothing you’ve made is lost: your Original is already real and resolvable as did:webvh. Try again in a few minutes.',
    indexerUnavailable:
      'We can’t read your deposit address on the Bitcoin network right now, so we can’t tell you what’s arrived — and we won’t show you a stale balance and call it current. No address is shown while that’s true. Anything you’ve already sent is untouched: it’s at your own address, under your own key, and it will still be there when the read comes back. Your Original is already real and resolvable as did:webvh in the meantime.',
    indexerBusy:
      'Our Bitcoin address lookups are being rate-limited at the moment, so we can’t confirm what’s at your deposit address just yet. Nothing is lost or stuck on your side — any BTC you’ve sent is at your own address, under your own key. Give it a few minutes and reload; we’ll pick up exactly where this left off.',
    // A shortfall names the number: "deposit more" without an amount is what
    // leaves someone topping up blind. Composed by depositShortfallMessage.
    shortfallPrefix: 'Your confirmed deposits come to',
    shortfallMiddle: ', which is',
    shortfallSuffix:
      'short of the amount above. Send the difference to the same deposit address and wait for one confirmation — the inscription will spend both payments together.',
    // The ordinal classification is unavailable, so nothing is spendable.
    ordinalCheckUnavailable:
      'We can’t currently check whether the coins at your deposit address carry an inscription of their own, and we won’t spend a coin we can’t check — an inscribed sat spent as a fee is destroyed. Your BTC is untouched at your own address. Try again in a few minutes.',
    ordinalCheckBadge: 'Can’t check your coins for inscriptions.',
    // The bindings file — the whole of "this address belongs to this account".
    bindingUnreadable:
      'We can’t confirm which deposit address belongs to your account right now, so we’re not showing one: a wrong address here means BTC sent somewhere this site can never spend from. Anything you’ve already sent is untouched. Try again in a few minutes.',
    bindingBadge: 'Deposit address unconfirmed.',
    networkMismatch:
      'This deploy is misconfigured: the app was built for a different Bitcoin network than the server is running. Inscribing is disabled until they match — no deposit address is shown, because funds sent to it could not be spent here.',
    yourKeyNote: 'Your Turnkey key signs this inscription in your browser; your own deposit pays the fee. The server never sees a private key.'
  },
  /**
   * The hosting layer, in visitor words. A raw `HttpHostingStorageAdapter.put
   * failed: 507` was reaching the page before this existed — a transport string
   * on screen, and a breach of the mechanical floor in GRADING.md.
   */
  hosting: {
    rateLimited:
      'That’s a lot of publishing at once, so the demo host asked us to slow down. Wait a few seconds and publish again — nothing you’ve made is lost, your Original is still signed and safe in this tab.',
    unavailable:
      'We couldn’t host the signed log just now, so your Original is still at did:cel — real, signed, and safe in this tab. Try publishing again in a moment.',
    quotaFull:
      'Your account has used up its hosting space, so there’s no room for another version right now. Everything you’ve already published is untouched and still resolvable.',
    // R7 — rendered in the PUBLISH step, before the button that publishes, not
    // only on the log that comes back afterwards. It is the one thing an
    // anonymous visitor cannot find out later.
    temporaryNote:
      'Publishing anonymously puts your signed log on a shared demo path, in memory, and drops it after a couple of hours. Sign in first and your Originals get their own path and are hosted for keeps, with the same signed history.'
  },
  /** Last resort: something we did not anticipate, said without a stack trace. */
  failure:
    'Something went wrong on our side. Nothing you’ve made is lost — your Original is still in this tab. Try that step again.',
  reset: 'Start over with a new asset'
};

export const yourOriginals = {
  navLabel: 'Your Originals',
  heading: 'Your Originals',
  subhead:
    'Every piece you’ve created and published lives here — each a real, resolvable did:webvh with a signed version history hosted at this origin.',
  signedOut: 'Sign in to see the Originals saved to your account.',
  loading: 'Loading your Originals\u2026',
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
  /**
   * R31 — a deposit-read outage is asynchronous: it can start after a creator
   * sends BTC and closes the tab, so the deposit screen's own copy reaches
   * nobody. This block is the version that greets them on their NEXT VISIT,
   * from the server's persisted alert.
   */
  depositAlert: {
    heading: 'About your Bitcoin deposit',
    // Mechanics, not a custody characterisation — the same rule U15 applied to
    // the deposit screen itself.
    unavailable:
      'While you were away, we lost our read of the Bitcoin network, so we can’t currently confirm what’s sitting at your deposit address. Your BTC is where you sent it: at your own address, under your own key, and nothing here can move it without your browser signing. Inscribing resumes on its own once the read is back.',
    busy:
      'Our Bitcoin address lookups are being rate-limited, so we can’t confirm your deposit right now. Nothing is lost: any BTC you sent is at your own address, under your own key. Try again in a few minutes.',
    heldPrefix: 'Last time we could see it, your deposit address held',
    heldSuffix: 'at',
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

/** The copyable install chip. `prompt` is the decorative shell sigil. */
export const installCommand = {
  prompt: '$',
  copy: 'Copy',
  copied: 'Copied',
  /** Composed with `site.install` for the button's accessible name. */
  copyAriaPrefix: 'Copy'
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
