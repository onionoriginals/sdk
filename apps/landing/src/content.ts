/**
 * All copy for the Originals landing page lives in this file.
 * Edit text here; layout and behavior live in the components.
 */

export const site = {
  /**
   * The tab, the Google result and every link preview. This is the FIRST
   * Originals copy most people meet, so it speaks to the creator the rest of
   * the page was rewritten for — not to a developer shopping for a package.
   * The old pair ('Originals SDK — …', 'Create, publish, and inscribe digital
   * assets … did:cel → did:webvh → did:btco') named the library and three DID
   * methods before it named anything a creator wants. Title stays under 60
   * characters and description under 155 so neither is truncated in search.
   */
  title: 'Originals — Proof you made it, carved into Bitcoin',
  description:
    'Screenshots are free. Provenance is not. Give your work a signed history of who made it and who owns it — anchored on Bitcoin, verifiable by anyone.',
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
  /**
   * Pinned to the `next` tag on purpose. npm's `latest` is still 2.1.0, a major
   * behind everything this page describes — did:cel, the CEL event log, the
   * curated exports, custody-required signers are all 3.x — so a bare
   * `npm install @originals/sdk` hands a developer a different SDK than the one
   * they just watched run. Drop the tag only when 3.0.0 is on `latest`.
   */
  install: 'npm install @originals/sdk@next'
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
  signOut: 'Sign out',
  /** Why Sign out is unavailable mid signing-session refresh (FR1). */
  signOutBlocked: 'Finish signing in again first — your Original and any BTC at your deposit address are still waiting.'
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
    'Mint a did:webvh signed by a key only this browser holds — yours to keep, and yours to prove this identity is yours.',
  createAction: 'Create your did:webvh',
  creating: 'Creating…',
  createFailed: 'DID creation failed — try again.',
  doneTitle: 'Your DID is signed',
  doneNote:
    'Signed by a key this browser holds, and stored here beside it. It isn’t published anywhere yet, so nothing else can look it up — and clearing this browser’s storage takes the key with it.',
  copy: 'Copy',
  copied: 'Copied',
  copyAria: 'Copy DID',
  copiedAria: 'DID copied',
  /**
   * U10 / R17 — shown BEFORE the key exists. Creating used to be one click, so
   * any warning beside the finished state arrived after the irreversible step.
   * `warning.reminder` is the same fact restated for a returning user.
   */
  warning: {
    title: 'First, the part nobody can undo for you',
    body:
      'Creating your DID generates a signing key that only this browser will hold. It signs this DID, and we never get a copy — so if this browser’s storage is cleared, or you move to another browser or device, the key is gone and no one can reissue it. The Originals you make are signed separately, by a key held for you, and they come back wherever you sign in.',
    remedy:
      'Save an encrypted backup as soon as it exists. That file, plus the passphrase you pick for it, is what carries this DID to another browser.',
    acknowledge: 'I understand this key will exist only in this browser',
    confirm: 'Create my DID',
    cancel: 'Go back',
    reminder:
      'Your signing key is still only in this browser. Clearing site data, moving to another browser, or a browser evicting storage all take it with them — and it cannot be reissued.',
    notAcknowledged: 'Confirm you understand before your key is created.'
  },
  /** U10 / R18 — the export half. Passphrase-wrapped; nothing is uploaded. */
  backup: {
    open: 'Save a backup',
    title: 'Save an encrypted backup',
    body:
      'Wraps your signing key and your DID into one file, encrypted with a passphrase you choose. Keep both — the file is useless without the passphrase, and no one can reset it for you.',
    passphraseLabel: 'Backup passphrase',
    passphrasePlaceholder: 'At least 10 characters',
    confirmLabel: 'Repeat passphrase',
    action: 'Download backup',
    working: 'Encrypting…',
    done: 'Backup downloaded. Store it somewhere you will still have next year.',
    mismatch: 'The two passphrases don’t match.',
    weak: 'Use a passphrase of at least 10 characters.',
    failed: 'Couldn’t create the backup — try again.',
    cancel: 'Cancel'
  },
  /** U10 / R18 — the import half, including the replace warning. */
  restore: {
    open: 'Restore from a backup',
    title: 'Restore from a backup',
    body:
      'Choose the backup file you saved and enter its passphrase. It is unwrapped here in your browser and never sent anywhere.',
    fileLabel: 'Backup file',
    passphraseLabel: 'Backup passphrase',
    action: 'Restore',
    working: 'Restoring…',
    done: 'Restored. This browser can sign as you again.',
    replaceTitle: 'This browser already holds a different key',
    replaceBody:
      'Restoring replaces it. Anything signed by the key that is here now can no longer be added to from this browser unless you also kept a backup of that one.',
    replaceAcknowledge: 'I understand the key in this browser will be replaced',
    replaceBlocked: 'Confirm the replacement before restoring.',
    noFile: 'Choose your backup file first.',
    wrongPassphrase: 'That passphrase doesn’t match this file.',
    malformed: 'That file isn’t an Originals backup.',
    failed: 'Couldn’t restore that backup — try again.',
    cancel: 'Cancel'
  }
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
   * What step 3 costs, for everyone who is NOT being handed a live quote — an
   * anonymous visitor, or any visitor on a deploy with real Bitcoin off. They
   * used to reach the end of the page without meeting a single number; the
   * Protocol table's "One-time network fees" is not a price.
   *
   * The figures are the server's own deposit quote, not an invention. See
   * `estimateInscriptionCostSats` in server/bitcoin.ts: a commit of
   * COMMIT_OVERHEAD_VB + P2TR_OUTPUT_VB + P2WPKH_OUTPUT_VB + one 68 vB input
   * (153 vB) plus a reveal of REVEAL_BASE_VB + ceil((contentBytes + 300) / 4)
   * — 2,186 vB at the 8,000-byte default the deposit route quotes when the
   * client sends no size hint, which this one never does. 2,339 vB total,
   * times the 1.5x buffer, plus POSTAGE_SATS: 4,055 sats at 1 sat/vB and
   * 18,089 at 5.
   *
   * Rounded, because the input the whole thing multiplies by is a live mempool
   * reading (`currentFeeRate` -> provider.estimateFee), and quoting four
   * significant figures off a number that moves would be a more precise lie.
   * Rounded UP, to 4,100 and 18,100: a price a creator is quoted must never
   * sit below what they will actually be asked for, and "around 4,000" was
   * 55 sats under the estimator's own answer. `demo-inscribe-cost.test.ts`
   * asserts that direction, so re-deriving these after a change to the buffer,
   * the postage, the default content size or the output set cannot quietly
   * reintroduce an understatement.
   */
  inscribeCost:
    'Running the simulation is free. Inscribing for real costs around 4,100 sats at 1 sat/vB, or 18,100 at 5 sat/vB, including the 546-sat output the inscription rides on. The rate moves, so you see the exact amount before you commit to it — a one-time on-chain fee paid to the Bitcoin network, and none of it is refundable.',
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
    unsigned: 'unsigned',
    /** Creator entries: the authenticity claim about what the work IS. */
    authenticityTitle: 'Authenticity — the creator’s record',
    /** Holder entries: chain of custody; can add to the story, never define the work. */
    custodyTitle: 'Custody — holders’ additions',
    heldBy: 'Held by',
    unverifiedAuthor: 'unverified author'
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
    // Deliberately does NOT offer "sign in again": this state is reached
    // because signing in is what failed. Promising a retry that cannot work is
    // the failure mode this string exists to avoid.
    unavailableHeading: 'Signing is unavailable right now',
    unavailableBody:
      'Signing isn’t working on this site right now, so inscribing is paused — this is on our end, not something you can fix by signing in again. Nothing is lost: your Original is still real and resolvable, and any BTC at your deposit address stays yours, at your own address, under your own key.',
    reauthCta: 'Sign in again to keep going',
    reauthPending: 'Waiting for you to sign back in…',
    preserved: 'Your Original is held right where you left it — signing back in picks up from here.',
    revokeFailed:
      'Signed out, and this browser’s signing key is erased. We couldn’t reach Turnkey to revoke it as well, so it stays valid there until it expires on its own.',
    // The erase itself failed — a stronger statement than revokeFailed, which
    // promises the local key is gone. On a shared machine this is the one the
    // person needs to read, so it must never be swapped for the softer line.
    eraseFailed:
      'Signed out — but we could not erase this browser’s signing key. It can still sign for up to 12 hours. If this machine is shared, clear this site’s data in your browser before you walk away.'
  },
  deposit: {
    heading: 'Fund your inscription',
    signInPrompt: 'Sign in to inscribe on Bitcoin — your own key signs it, your own BTC funds it.',
    sendPrefix: 'Send at least',
    sendSuffix: 'of BTC to your deposit address. One payment or several — the inscription spends every confirmed deposit sitting there, so a top-up after a fee rise works too. The change and the inscribed sat come back to the same address.',
    addressLabel: 'Your deposit address',
    // The redesign (see DepositPanel): the action comes first and the full
    // R27 text moves into an always-present <details> below it. These two
    // lines are what stays visible without interaction — the purpose, and the
    // SUBSTANCE of the two money risks. The long-form lines below are not
    // replaced by them; they are still rendered, in full, on the same screen.
    purposeShort:
      'Covers the Bitcoin network fees for two transactions, plus the 546-sat output your inscription rides on. Change comes back to this address.',
    riskSummary:
      'There is no withdraw or refund. Anything you send that isn’t spent on an inscription stays at this address until you inscribe here again, and a broadcast fee can’t be reversed by anyone, us included. Send the amount above rather than a round number you’d want back.',
    detailsSummary: 'How this works — the address, your key, and closing the tab',
    copyAddress: 'Copy',
    copiedAddress: 'Copied',
    copyAddressAria: 'Copy your deposit address',
    openInWallet: 'Open in wallet',
    openInWalletHint: 'Opens your Bitcoin wallet with the address and amount already filled in.',
    scanHint: 'Or scan to pay from your phone',
    // Between sending and confirming, a creator has no way to tell whether we
    // can see their money — and that is the worst moment to say nothing.
    pendingSeenSuffix: 'in the mempool — we can see it, waiting for one confirmation.',
    pendingViewLink: 'View transaction',
    // The funded state. Previously the panel said "Send at least N sats" even
    // once the deposit covered the cost, so a creator who had already paid was
    // still being told to pay and had no idea the next move was theirs.
    fundedHeading: 'Funded — ready to inscribe',
    fundedBody: 'Your deposit covers this inscription. Use the button below to inscribe on Bitcoin.',
    balanceLabel: 'Your deposit balance',
    balanceNeeded: 'needed for this inscription',
    addMoreSummary: 'Add more funds, or see the deposit address',
    // The commit landed but the reveal did not propagate. The inscription is
    // NOT on chain yet, and saying "inscribed" here is the same dishonesty as
    // telling someone to sign in again when signing in is what failed.
    commitOnlyHeading: 'Commit broadcast — the inscription finishes shortly',
    // The sat is decided by the commit's first input, so it IS known already;
    // the inscription that will ride on it is not on chain yet.
    commitOnlySatPrefix: 'It will land on satoshi',
    commitOnlyBody:
      'Your funding transaction is on the network. The second transaction, the one that carries the inscription, has not propagated yet — this is expected while the first is still unconfirmed. It is signed and saved on our side and goes out automatically once the first confirms. Nothing is stuck and nothing more is owed; your Your Originals page shows it through to done.',
    balanceReuse:
      'Anything left over stays at this address and pays for your next inscription here — you will not be asked to deposit again while it covers the cost.',
    // A CONFIRMED deposit that does not cover the cost. Distinct from
    // 'detected', whose copy promises a confirmation that already happened.
    shortBadge: 'Deposit confirmed — a top-up is needed.',
    shortTopUpPrefix: 'Send',
    shortTopUpSuffix:
      'more to the same address. The quote above already includes the cost of spending that second payment, so this amount is the whole gap.',
    // A pending deposit paying under the going rate. We cannot fix this: the
    // inputs belong to the wallet the creator sent from, so only that wallet
    // can replace the transaction. Saying so beats a button that cannot work.
    feeLowHeading: 'Your deposit is paying below the going rate',
    feeLowBody:
      'It will still confirm — it is queued behind higher-paying transactions, not stuck — and nothing is at risk while it waits.',
    feeLowBumpable:
      'If your wallet has a “bump fee” or “speed up” option, this payment can be replaced. Two things to get right: take the increase from your change, never from the deposit amount, and aim for the rate below — Bitcoin makes a replacement pay for its own bandwidth on top of the original fee, so a small nudge is rejected outright.',
    feeLowUnbumpable:
      'Your wallet did not mark this payment replaceable, so its fee cannot be raised. Waiting is the only option, and it will get there.',
    feeLowYours: 'Yours',
    feeLowNetwork: 'Clearing now',
    feeLowSuggest: 'Replace at',
    feeLowMinimum: 'At least, if the replacement is the same size',
    // sendSuffix continues the "Send at least <n> sats" sentence, so it cannot
    // stand alone now that the amount lives in its own block. This is the same
    // point as a whole sentence.
    // Accurate about where money goes: selectFundingUtxos takes largest-first
    // and STOPS once the target is covered, so a deposit it does not need is
    // left at the address — and there is no withdrawal path for it. The old
    // line promised the opposite ("spends every confirmed deposit").
    topUpNote:
      'Several payments work too: the inscription spends what it needs, largest first, and leaves the rest at the address.',
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
    // The account is bound to a DIFFERENT address than this browser derived.
    // Never show either one: one of them cannot be spent from here.
    addressNotBound:
      'Your account is already bound to a different deposit address than this browser derived, so we’re not showing one — BTC sent to the wrong one could never be spent here. Anything you’ve already sent is untouched at your own address. Sign in again on the browser you first used, or come back in a few minutes.',
    // 401 from the deposit route: the 7-day session ended under the tab.
    signedOut:
      'Your sign-in has expired, so we can’t look up your deposit address any more. Sign in again to pick this up — nothing is lost: any BTC you’ve sent is at your own address, under your own key.',
    signedOutBadge: 'Sign in again to continue.',
    // The DEFAULT arm. Every unrecognised failure lands here rather than
    // clearing the banner and leaving the last address and quote on screen —
    // a stale "ready to inscribe" is how someone is told to send more money
    // against a number nothing checked.
    unknownError:
      'We couldn’t confirm your deposit just now, so we’re not showing an address or an amount — showing a stale one is how BTC ends up somewhere we can’t spend from, or priced against a fee that has moved. Nothing is lost: anything you’ve already sent is at your own address, under your own key. Give it a minute and reload.',
    unknownBadge: 'Deposit check failed.',
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
   * The pre-broadcast resume gap: a published Original that was never
   * inscribed. Distinct from `finish` above, which recovers an inscription
   * that WAS built and signed — these two never appear on the same row.
   *
   * The disabled reasons are the honest half. Inscribing appends a signed
   * migrate event, and pre-anchor the CEL accepts only its current controller
   * as signer, so an Original minted before authorship moved into Turnkey
   * custody answers to a key that lived in a tab and is gone. That cannot be
   * fixed by signing in again on another device, and the copy must not imply
   * it can.
   */
  inscribe: {
    cta: 'Inscribe on Bitcoin',
    /**
     * The detail-page section heading. Neutral on purpose, and never the CTA
     * text: the same section carries the reason an Original CANNOT be
     * inscribed, where "Inscribe on Bitcoin" would read as an offer being
     * withdrawn — and above the button it would just say the same thing twice.
     */
    sectionEyebrow: 'Bitcoin',
    busy: 'Inscribing…',
    hydrating: 'Rebuilding from its signed log…',
    done: 'Inscribed — the transactions are on their way to the network.',
    /**
     * Only the commit reached the network. The reveal carries the inscription,
     * so until it propagates there is nothing on chain — saying "inscribed"
     * here is the same lie #506 removed from the demo. Nothing more is owed;
     * the server re-pushes the reveal on its own.
     */
    commitOnly:
      'Your funding transaction is on the network. The second transaction — the one that carries the inscription — has not propagated yet, which is expected while the first is unconfirmed. It is signed and saved, and goes out automatically. Nothing is stuck and nothing more is owed.',
    /** Shown under a disabled action, keyed by `DisabledReason`. */
    reasons: {
      'signed-out': 'Sign in to inscribe this Original on Bitcoin.',
      'no-authorship-key':
        'This browser can’t reach your signing key right now, so it can’t sign the event inscribing adds. Sign in again and it will come back.',
      'foreign-controller':
        'This Original was made before signing keys were kept for you, so the key that could add to its history only ever existed in the browser that created it — and it’s gone. Everything already in its history stays signed, verifiable and hosted; it just can’t be carried on to Bitcoin. Anything you make from now on can be.',
      /**
       * Not fetched yet. Rendered as NOTHING, not as this text: on first paint
       * no row's log has been read, so showing it flashed a note under every
       * card. Kept as a string for a caller that wants to say it out loud.
       */
      reading: 'Reading this Original’s signed log…',
      /** Fetched, and it did not come back readable. A real answer, so it shows. */
      unreadable:
        'This Original’s signed log could not be read from where it is hosted, so there is nothing to carry to Bitcoin yet. Reloading may fix it.',
      /**
       * An inscription is already built and paid for and waiting to be pushed,
       * and we cannot tell which Original it belongs to. Rebuilding would
       * replace it, so the copy points at the thing that clears it rather than
       * describing the ambiguity — finishing it is one click away, above.
       */
      'pending-elsewhere':
        'You have an inscription that’s already built and waiting to be sent. Finish that one first — until it lands, starting another could replace it.',
    },
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
  versionNote:
    'The 3.x line is what this page runs; it ships under the `next` tag until 3.0.0 is released.',
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
    },
    /**
     * R19. These two are the only in-app footer links — root-relative hrefs the
     * Footer routes through navigate() instead of opening in a new tab. See
     * `legal` below for the copy they lead to.
     */
    {
      title: 'Legal',
      links: [
        { label: 'Privacy', href: '/privacy' },
        { label: 'Terms', href: '/terms' }
      ]
    }
  ]
};

/**
 * R19 — the privacy and terms pages, served at '/privacy' and '/terms'.
 *
 * Every claim below is checked against the code it describes by
 * `src/pages/legal.test.ts`: the cookie config, the browser storage keys, the
 * durable server trees, and the money-event union. A category the app stores
 * and this page omits is the failure mode these pages exist to avoid.
 *
 * The one thing deliberately ABSENT is a custody characterisation. "Never
 * holds user funds or keys" is a legal conclusion about an arrangement whose
 * status is contested and which we have not had read; publishing it would be a
 * written representation to every visitor. `terms.sections` names the gap and
 * describes the mechanism instead — where each key lives, who signs, and what
 * can and cannot move a balance.
 */
export const legal = {
  updatedLabel: 'Last updated',
  updated: '19 August 2026',
  privacy: {
    navLabel: 'Legal',
    heading: 'Privacy',
    subhead:
      'What this site collects, where it goes, and how long it stays. No analytics script, no advertising, and no third-party tracker runs on this page — everything below is something the app needs in order to work.',
    sections: [
      {
        heading: 'Your email address',
        body: [
          'Signing in means giving an email address to Turnkey, the key-management service this site is built on. Turnkey mints the six-digit code and sends that mail; the message does not come from us.',
          'While a code is outstanding, the server keeps your address in memory beside the pending sign-in and drops it after fifteen minutes or once the code is used. It is not written to disk.',
          'Your address is also a claim inside the signed token in your session cookie, so it travels with each request your browser makes while you are signed in.',
          'Nothing we publish contains it. The path your did:webvh lives under is derived from your Turnkey sub-organization id, not from your address.',
          'We do not send you email ourselves — not for a stuck deposit, not for anything else, and there is no mailing list. Your Originals is the page a problem shows up on.'
        ]
      },
      {
        heading: 'Cookies',
        body: [
          'One cookie, auth_token. It holds a signed token naming your Turnkey sub-organization id and your email address. It is HttpOnly, so page scripts cannot read it; SameSite=Strict, so it is not sent on requests coming from other sites; and it expires seven days after it is issued. Signing out clears it.',
          'That is the only cookie this site sets. There is no analytics cookie, no advertising cookie, and no third-party script here that could set one.'
        ]
      },
      {
        heading: 'Keys held in your browser',
        body: [
          'The Ed25519 key that signs your own did:webvh identity lives in this browser’s localStorage, together with the DID log it created. Neither is ever sent to the server, and nothing on our side can reissue them: clearing site data, switching browsers, or the browser evicting storage destroys them for good.',
          'The key that signs the Originals you author while signed in is a different key, and it is not held here: it is an Ed25519 key in your Turnkey sub-organization, which is what lets an Original you published on one device still be carried to Bitcoin from another. Signed out, that key does not exist and the Original is signed by a key generated in the page and discarded with it.',
          'The backup file you can download is wrapped with your passphrase inside the browser before it is written to disk. No copy of the file, and no copy of the passphrase, reaches the server.',
          'The key authorising your Turnkey session is a non-extractable WebCrypto key in this browser’s IndexedDB — it can be asked to sign, but its private half cannot be read back out, by our code or anyone else’s. localStorage holds only the sub-organization id, the matching public key, and the expiry time.'
        ]
      },
      {
        heading: 'What the server stores',
        body: [
          'The Originals you publish while signed in are written to a mounted volume: the did:webvh log, the CEL event log, and the bytes of the artwork itself, indexed under your Turnkey sub-organization id. Publishing is what makes them public — they are served at the exact URLs a DID resolver fetches, so anyone holding the DID can read them.',
          'When you inscribe, the signed commit and reveal transactions are stored before anything is broadcast. That copy is what lets the server finish an inscription for a browser tab that died between the two, and it stays on the volume afterwards — only a superseded pair that can no longer land has its signed transactions dropped. A per-account ceiling bounds how many of these records are kept, oldest spent ones first.',
          'The deposit address your account is bound to is stored too, along with the last balance read we could trust and any unresolved problem reading it, in a file named after your sub-organization id. That is what puts a warning on Your Originals after you have closed the tab.',
          'The anonymous demo stores nothing durable. What it publishes goes to an in-memory store with a size budget and a time limit, and it is gone by the next deploy.'
        ]
      },
      {
        heading: 'Server logs',
        body: [
          'Every point at which real Bitcoin moves or gets stuck writes one line to the server’s standard output, prefixed [landing][money], which the hosting platform’s log drain collects. Those lines are the only instrument we have for noticing that someone’s funds are stranded.',
          'A line carries the event name and a timestamp, your Turnkey sub-organization id, the Bitcoin network, the deposit address, sat amounts, transaction ids, and a reason where something failed. The events are:'
        ],
        list: [
          'deposit_address_issued — an address is bound to your account for the first time',
          'deposit_seen — a confirmed balance appears at that address',
          'deposit_shortfall — the balance changed and still does not cover the quote',
          'deposit_read_failed — an address read, or the address binding, could not be trusted',
          'deposit_ordinal_check_unavailable — coins could not be checked for inscriptions, so none were offered as spendable',
          'inscribe_attempted — a signed pair passed validation and is about to broadcast',
          'inscribe_failed — a pair was refused or failed to broadcast',
          'inscribe_broadcast — a pair reached the network',
          'deposit_balance_held — the hourly sweep found a bound address still holding confirmed sats',
          'deposit_balance_sweep — the roll-up of that sweep, including how many addresses hold a balance'
        ],
        footer: [
          'You are identified by your Turnkey sub-organization id, never by your email address. The formatter enforces that rather than trusting the code calling it: a field named like an email, or any value shaped like an email address, is replaced with [redacted] before the line is written.',
          'Retention is the hosting platform’s rather than ours. The lines sit in its log drain for as long as it keeps them; we set no separate window and copy them nowhere else.',
          'Separately, requests are rate-limited against a client identity derived from your network address. Those counters live in memory, are bounded in size, are never written to disk, and are lost on every restart.'
        ]
      },
      {
        heading: 'Who else sees anything',
        body: [
          'Turnkey, which holds your account and mails your sign-in code, and which your browser talks to directly when it opens a signing session.',
          'A Bitcoin index (mempool.space unless configured otherwise) and a QuickNode Bitcoin endpoint, which the server queries to read your deposit address and to broadcast your transactions. Those requests leave the server carrying a Bitcoin address, never your email address.',
          'The hosting platform, which runs the server and collects its logs.',
          'Nobody else. Nothing here is sold, and there is no analytics or advertising vendor to share it with.'
        ]
      },
      {
        heading: 'Asking about your data',
        body: [
          'There is no self-serve delete. An Original you have published is meant to be fetched by strangers, and one you have inscribed is on Bitcoin, where nothing can remove it. What we can do is stop serving our copies and delete the account files described above — a manual step on our side rather than a button.',
          'The project’s GitHub repository is where to reach us. It is a public issue tracker, so keep anything private out of the issue itself.'
        ]
      }
    ]
  },
  terms: {
    navLabel: 'Legal',
    heading: 'Terms',
    subhead:
      'What this site does, what it cannot do, and what happens to Bitcoin you send it.',
    sections: [
      {
        heading: 'What this is',
        body: [
          'Originals is a demonstration of the Originals protocol, and also the protocol’s first real user-facing surface. You create an Original, publish it as a did:webvh anyone can resolve, and — signed in — inscribe it on Bitcoin mainnet with your own coins.',
          'The SDK underneath is open source under the MIT licence. The hosted site is run as-is, by one person, with no uptime guarantee and no support commitment. It may change, and it may stop.'
        ]
      },
      {
        heading: 'Your account and your keys',
        body: [
          'You need an email address you can receive mail at; the code Turnkey sends to it is the whole of signing in.',
          'The key that signs your work is generated in your browser and stays there. If you lose it we cannot reissue it and cannot re-sign anything as you. Download the backup before you rely on anything you have made here.'
        ]
      },
      {
        heading: 'What you publish is public, and an inscription is permanent',
        body: [
          'Publishing an Original serves its log, its event history and its bytes at public URLs, because being fetchable by a stranger is the point of a did:webvh. Do not publish anything you would need to take back.',
          'Inscribing writes those bytes onto a satoshi on Bitcoin. We can stop serving our copy; nobody can remove the inscription.',
          'Publish work you hold the rights to, and not content it would be unlawful to distribute. When we learn otherwise we will take our copy down and stop serving the account, and that is the only remedy that exists on our side.'
        ]
      },
      {
        heading: 'Bitcoin: who signs, and what can move',
        body: [
          'The address you deposit to is derived in your browser from your Turnkey wallet. Your account is bound to the first address your browser presents, and the server does not re-derive or re-check it afterwards.',
          'Your browser signs both transactions of an inscription with that wallet’s key, through your Turnkey session. The server never receives a private key.',
          'The signed pair is stored on the server before it is broadcast, so a tab closing mid-flow cannot strand the coins the first transaction already committed. The server rebroadcasts the second transaction to finish the inscription.',
          'Bitcoin transactions cannot be reversed. Once a pair is broadcast the network fee is spent, and nobody — us included — can undo or refund one.',
          'There is no withdraw and no refund path on this site. Bitcoin you send that is never spent on an inscription stays sitting at that address, and the only way to move it is to inscribe again here, for as long as this service and its Turnkey organization are running. Send the amount the deposit screen quotes rather than a round number you would want back.',
          'That quote is an estimate with a buffer on it. The change, and the satoshi carrying the inscription, come back to the same address.',
          'We can switch the Bitcoin path off — for an outage, a misconfiguration, or an inscription we cannot clear. While it is off, a confirmed deposit stays exactly where it is and cannot be spent through this site.'
        ]
      },
      {
        heading: 'What this page does not say',
        body: [
          'You will not find a statement here about the custody status of the arrangement above. That is a legal characterisation; we have not obtained one, and publishing a guess would be a written representation to everyone who reads it.',
          'What is written above is the mechanism instead: where each key lives, who signs, what the server holds and when, and what can and cannot move a balance. If you need the legal characterisation before you send Bitcoin, do not send it yet.'
        ]
      },
      {
        heading: 'Status of this page',
        body: [
          'These pages describe how the software actually works, checked against the code they describe. They have not been through a legal review and they are not legal advice. Where a question needs a lawyer rather than an engineer, this page names the gap instead of filling it.',
          'This page changes as the site does, and the site’s history is public in the project’s repository.'
        ]
      }
    ]
  }
};
