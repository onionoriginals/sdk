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
   * assets … local → did:webvh → did:btco') named the library and three DID
   * methods before it named anything a creator wants. Title stays under 60
   * characters and description under 155 so neither is truncated in search.
   *
   * Neither claims "first" or an instant Bitcoin timestamp (#605): Bitcoin
   * resolution is sat-scoped (`crossSatCanonicality: 'unknown'`), so the
   * protocol cannot rule out a competing creation on another sat, and
   * publishing to the web and inscribing on Bitcoin are separate, sequential
   * steps — never "the moment you publish". What it can prove is a signed,
   * byte-exact history that anyone can re-check, later anchored and ordered
   * on Bitcoin.
   */
  title: 'Originals — Give your work a history',
  description:
    'Keep a signed history of your work. Start privately, publish when ready, and choose whether to record ownership on Bitcoin.',
  /**
   * The production origin. Single source of truth: injected into index.html
   * (canonical, og:url, og:image, twitter:image) at build time, and
   * public/robots.txt and public/sitemap.xml must carry the same origin —
   * the build fails with a pointed error if they drift.
   */
  url: 'https://originals.build',
  tagline: 'Provenance that survives the internet.',
  ogImageAlt:
    'A total eclipse with a bright diamond of light on its edge, beside the Originals wordmark and the line “Give your work a history.”',
  wordmark: 'Originals',
  github: 'https://github.com/onionoriginals/sdk',
  /**
   * Pinned to the `next` tag on purpose. npm's `latest` is still 2.1.0, a major
   * behind everything this page describes — the SDK this page runs is newer
   * than `latest` — so a bare
   * `npm install @originals/sdk` hands a developer a different SDK than the one
   * they just watched run. Drop the tag only when 3.0.0 is on `latest`.
   */
  install: 'npm install @originals/sdk@next'
};

export const nav = {
  links: [
    { label: 'Why Originals', href: '#why' },
    { label: 'Try it', href: '#demo' },
    { label: 'How it works', href: '#protocol' },
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
 * The signed-in hero panel. The DID it makes is signed by a Turnkey-held
 * Ed25519 key and its log is published to this origin (auth/webvh.ts), so it
 * resolves and it survives this browser. Custody is stated, never implied: the
 * old copy promised "we never get a copy", and quietly downgrading that to
 * custody is the kind of thing a user should never discover on their own.
 */
export const identityPanel = {
  layerLabel: 'Your identity',
  idleTitle: 'Use the same identity on any device',
  idleBody:
    'Create a public identity for signing your work. Turnkey holds the signing key for you, so there’s nothing to back up. Sign in to use it again.',
  createAction: 'Create your identity',
  creating: 'Creating…',
  createFailed: 'Couldn’t create your identity. Try again.',
  doneTitle: 'Your identity is ready',
  doneNote:
    'Your public identity is saved on this site. Use it from any browser or device you sign in from.',
  /** The custody fact itself, stated plainly rather than buried in legal. */
  custodyNote:
    'Turnkey holds the key used to sign your work. We can request signatures only while you’re signed in. If you prefer to hold your own key, our developer tools let you sign on your device without connecting to this service.',
  /** Creating needs a live signing session (auth/webvh.ts TurnkeyWebVHSigner). */
  sessionRequired: 'Sign in again to create your identity.',
  copy: 'Copy',
  copied: 'Copied',
  copyAria: 'Copy identity',
  copiedAria: 'Identity copied'
};

export const hero = {
  /**
   * The eclipse hero. `evidence` describes the bundled "First Light" example
   * (public/example/first-light.originals.zip, scripts/make-example.ts): a
   * local Original, neither published nor on Bitcoin, and the lines say so.
   */
  evidence: {
    caption: '“First Light”, an example Original',
    events: [
      { label: 'Created', value: 'Signed by its author’s DID', done: true },
      { label: 'Published', value: 'Not yet. Its author’s choice.', done: false },
      { label: 'On Bitcoin', value: 'Not added. Its owner’s choice.', done: false }
    ]
  },
  record: {
    headline: 'The record keeps going.',
    line: 'Every new version is signed and linked to the one before.',
    note: 'Example history, not live transactions.',
    events: [
      { title: 'Created', body: 'The first signed record.' },
      { title: 'Revised', body: 'A new version linked to the last.' },
      { title: 'Published', body: 'A record others can inspect.' }
    ]
  },
  closing: 'Make something worth remembering.',
  eyebrow: 'Signed history · Recorded on Bitcoin',
  headline: 'Give your work a history.',
  subhead:
    'Keep a signed record of your work as it changes. Start with a private draft, publish it for others to check, and choose whether to record ownership on Bitcoin.',
  /** Interim target: points at the demo until the creator-app upload flow ships. */
  primaryCta: { label: 'Make your first Original', href: '#demo' },
  exampleLink: { label: 'See one that already exists', href: '#example' },
  pipelineCaption:
    'Start with a private draft. Publish it on the web, then add it to Bitcoin if you choose. Each step becomes part of its signed history.'
};

export const layers = [
  {
    id: 'did:vh' as const,
    name: 'Create',
    title: 'Create',
    role: 'Private draft',
    blurb: 'Create a signed record on your device. Keep it private until you publish.',
    facts: ['Costs nothing', 'Works offline', 'Private until published']
  },
  {
    id: 'did:webvh' as const,
    name: 'Publish',
    title: 'Publish',
    role: 'Public discovery',
    blurb: 'Publish on your domain with a signed record of each version.',
    facts: ['On your website', 'Past versions preserved', 'Anyone can check']
  },
  {
    id: 'did:btco' as const,
    name: 'Add to Bitcoin',
    title: 'Add to Bitcoin',
    role: 'Bitcoin ownership',
    blurb: 'Record ownership on Bitcoin so it can be transferred.',
    facts: ['Recorded on Bitcoin', 'Transferable', 'Network fees apply']
  }
];

export const why = {
  id: 'why',
  eyebrow: 'Why it matters',
  headline: 'The internet copies. Originals keeps the signed record.',
  subhead:
    'Originals keeps a signed record of your work and its changes. Others can check that record, and you can choose to add it to Bitcoin.',
  cards: [
    {
      title: 'A history anyone can check',
      body: 'Anyone can check the signatures in an Original’s history without an account or permission from us. Bitcoin ownership details come from a third-party data service and depend on its accuracy; your browser does not check them directly against Bitcoin itself.'
    },
    {
      title: 'Publish when you’re ready',
      body: 'Start with a free, private draft. Publish it on the web when you want to share it. Pay Bitcoin fees if you choose to record ownership there. You can stop at any stage; moving to the next stage cannot be undone.'
    },
    {
      title: 'Keep a copy you can check later',
      body: 'Originals uses open standards, with no company-owned registry or separate token. Once you add an Original to Bitcoin and keep a copy of its signed history, you can check it even if we stop operating. Until then, the online record depends on this site. Export a copy.'
    }
  ]
};


export const demo = {
  id: 'demo',
  eyebrow: 'Live demo',
  headline: 'Make an Original.',
  /**
   * Tier-aware (R8). The old single subhead told everyone "Bitcoin steps use
   * the SDK's built-in mock Ordinals provider" — printed directly above what
   * is, for a signed-in visitor, a live mainnet money button. The lead is true
   * for both tiers; the tail states which of the two is reading it.
   */
  subhead:
    'Name a piece to generate artwork in your browser, upload a file, or write something. Originals keeps a signed record of the exact content you choose.',
  subheadReal:
    'The final step adds it to Bitcoin. Your signing key approves the transactions through this browser, and your own BTC pays the network fees.',
  subheadSimulated:
    'Publishing to the web and adding to Bitcoin return soon. You can create and revise your Original now, and download its signed history.',
  /** Only appended where signing in genuinely buys a real inscription. */
  subheadSignIn: 'Sign in to add your Original to Bitcoin using your own BTC.',
  consoleHint:
    'You can inspect the steps as they run in your browser’s developer console.',
  form: {
    draftLabel: 'Draft',
    titleLabel: 'Title',
    titlePlaceholder: 'e.g. Study No. 1',
    defaultTitle: 'Study No. 1',
    sourceLabel: 'Source',
    sourceGenerate: 'Generate',
    sourceUpload: 'Upload',
    sourceWrite: 'Write',
    uploadCta: 'Choose a file',
    uploadHint: 'Any file up to 32 KB. Your signed history records the exact file you choose.',
    uploadTooBig: 'Choose a file up to 32 KB. Larger files cost more to add to Bitcoin, so this demo keeps them small.',
    uploadReadError: 'There was a problem reading that file. Try again.',
    uploadEmpty: 'That file is empty. Choose one with content.',
    uploadBinaryPreview: 'This file has no preview. You can still create a signed record of it and publish it.',
    writePlaceholder: 'Type or paste your text. Originals records exactly what you write.',
    writeEmpty: 'Write something first.',
    writeHint: 'Your signed history records exactly what you write.',
    styleLabel: 'Style',
    regenerate: 'Regenerate',
    artHint: 'Generated in your browser using the style you choose.'
  },
  steps: [
    {
      id: 'create',
      action: 'Create Original',
      pending: 'Creating…',
      title: 'Create',
      layer: 'did:vh',
      label: 'Private draft',
      description:
        'Creates a signed record of your file. It stays private until you publish. When you’re signed in, Turnkey holds your signing key. Otherwise, the key and your work stay in this tab.'
    },
    {
      id: 'publish',
      action: 'Publish to web',
      pending: 'Publishing…',
      title: 'Publish',
      layer: 'did:webvh',
      label: 'On the web',
      description:
        'Makes your signed history available on this site, then checks that it can be opened.'
    },
    {
      id: 'inscribe',
      action: 'Add to Bitcoin',
      pending: 'Adding to Bitcoin…',
      title: 'Add to Bitcoin',
      layer: 'did:btco',
      label: 'On Bitcoin',
      // The signed-in mainnet tier. This step is LIVE: it spends the creator's
      // own confirmed deposit. The string it replaced ("Coming soon … once
      // testnet4 ordinals support ships") was wrong about the status and the
      // network, and rendered to every visitor regardless of tier.
      description:
        'Adds your published Original to Bitcoin. Your key approves the transactions through this browser, and your own deposit pays for them.'
    }
  ],
  /** Live transaction fees depend on the complete publication. */
  inscribeCost:
    'Creating and publishing on the web require no Bitcoin fee. Adding an Original to Bitcoin uses a current fee quote based on file size and signed history. The fee is checked before the transactions are sent; network fees are not refundable.',
  /**
   * The simulated tier (R6). An anonymous visitor CAN complete step 3, so the
   * copy names it a simulation outright rather than promising a real
   * inscription later — the visual treatment carries the same signal.
   */
  simulated: {
    badge: 'Account required',
    action: 'Sign in to add to Bitcoin',
    pending: 'Preparing…',
    description:
      'Adding an Original to Bitcoin requires a signed-in account, a funded address and Bitcoin support on this site.',
    note:
      'Your Original is published on the web. To add it to Bitcoin, sign in on a site where Bitcoin is enabled and fund the fee.'
  },
  /**
   * Steps that wait on later phases of the Originals Protocol (plan 011). Said
   * plainly, in the step itself, so a disabled button is never a mystery.
   */
  unavailable: {
    badge: 'Coming back',
    /** The publish step's badge when only sign-in is missing (#976 B5). */
    signedOutBadge: 'Sign in to publish',
    hostedPublication:
      'Publishing to the web is being rebuilt on the Originals Protocol and returns soon. Your Original is complete without it: download its evidence to keep a copy anyone can check.',
    bitcoinAnchoring:
      'Adding to Bitcoin is being rebuilt on the Originals Protocol and opens after its release checks pass.'
  },
  /**
   * Anchoring an Original on Bitcoin (plan 011, PR 10b; behind bitcoinAnchoring).
   * Each label names one state of the anchor (P9.18); none of them is a verdict
   * on anything else (history, author, files and holder are reported apart).
   */
  anchoring: {
    beforeHeading: 'Before you sign',
    terminal:
      'Anchoring happens once and cannot be undone: from then on, Bitcoin is where this Original’s history is read, and each new version is inscribed on the same sat.',
    twoKeys:
      'Two keys sign. Your authorship key signs the entry that names the sat; your deposit key signs the Bitcoin transaction that pays for it. Holding the sat makes you its owner, not its author: only the authorship key can change the Original.',
    offChainLead: 'Bitcoin will hold the signed history only. These stay off chain, with you and this site:',
    offChainIdentity: (did: string) => `the history of your DID, ${did}`,
    offChainNote:
      'Nothing guarantees anyone else keeps them. Download the evidence package to keep your own copy, and hand it on with the sat if you sell or give it away.',
    cancel: 'Cancel',
    cancelled: 'Cancelled before anything was sent. Nothing was spent.',
    sessionExpired:
      'Your signing session expired before the next signature, so nothing was sent. Sign in again, then retry: anything already signed is kept.',
    retry: 'Retry',
    resend: 'Send again',
    resendNote:
      'The server never answered the last send. Sending again uses the same signed transactions, so nothing is paid twice.',
    labels: {
      'not-anchored': 'Not on Bitcoin',
      'submitted-unobserved': 'Sent, not seen on the network yet',
      'pending-bitcoin-acceptance': 'Pending Bitcoin acceptance',
      anchored: 'Anchored on Bitcoin',
      unverified: 'Bitcoin evidence missing or disputed',
    } as Record<string, string>,
    labelNotes: {
      'not-anchored': 'Nothing for this Original is known to be on its way to Bitcoin.',
      'submitted-unobserved':
        'The transactions were handed to the network, but no node we read shows them. The server sends the same ones again; nothing new is signed.',
      'pending-bitcoin-acceptance':
        'On its way: the inscription is in the network, and Bitcoin has not accepted it yet. It counts at one confirmation.',
      anchored: 'Bitcoin shows the anchor. Each later version is inscribed on the same sat, one per block.',
      unverified: 'The index we read could not show the sat, or two indexes disagree. Nothing is prepared or sent until they agree.',
    } as Record<string, string>,
    actions: {
      resume: 'The server holds a pair for the next entry and is sending it again.',
      'wait-for-confirmation': 'Waiting for a block to confirm the inscription.',
      'wait-for-evidence': 'Waiting for the signer history this inscription names before anything else is sent.',
      'wait-for-bitcoin': 'Indexes disagree about the sat or its holder: waiting before preparing or sending anything.',
      refused: 'A recorded inscription no longer checks out, so it will not be sent.',
    } as Record<string, string>,
    confirmations: (n: number) => (n === 1 ? '1 confirmation' : `${n} confirmations`),
    unpublished: (n: number) => (n === 1 ? '1 version is not on Bitcoin yet.' : `${n} versions are not on Bitcoin yet.`),
    inscribeNext: 'Inscribe the next version',
    inscribeNextPending: 'Inscribing…',
    holderLead: 'Held in',
    holderNote: 'The sat’s holder owns the Original. Ownership is reported, never established; it confers no right to change it.',
    holderElsewhere: 'The sat is no longer at your address. Whoever holds it now is the one who can inscribe next.',
    indexSingle: (index: string) => `Read from one index (${index}); no second index was compared.`,
    indexCompared: (indexes: string[]) => `Read from ${indexes.length} indexes that agree: ${indexes.join(', ')}.`,
    neverCurrentNote: 'Until Bitcoin shows the anchor, this Original is valid as of its last version, never confirmed current.',
  },
  evidence: {
    action: 'Download evidence',
    pending: 'Packaging…',
    note:
      'A ZIP with the signed history, the author’s DID and the files. Anyone can check it offline, with no account and no key.'
  },
  revise: {
    heading: 'Edit it—keep every version',
    body:
      'For generated artwork, changing the title creates a new image. Save a revision to add it and its description to the signed history. Before publication, revisions stay on your device and cost nothing. After publication, new versions are uploaded to this site, and earlier versions remain available.',
    regenerateAction: 'Shuffle artwork',
    action: 'Save revision',
    pending: 'Saving revision…',
    discard: 'Discard revision',
    unsignedBadge: 'Unsaved revision',
    unsignedNote:
      'This edit is only in your browser. Save it to add it to the signed history, or discard it to keep the previous version.',
    versionLabel: 'artwork',
    committedNote:
      'Each saved revision links to the previous version. Open History to see them.',
    lockedNote:
      'Updating an Original after adding it to Bitcoin requires another paid transaction. This demo stops before that step.'
  },
  eventLog: {
    detailsLabel: 'View signature details',
    identityLabel: 'History ID',
    entryLabels: { create: 'Created', update: 'Revised', deactivate: 'Ended' } as Record<string, string>,
    title: 'History',
    empty: 'Your history starts here',
    emptyHint: 'Create an Original to see its signed history here.',
    emptyUpcoming: ['Create', 'Publish', 'Add to Bitcoin'],
    sourceNote: 'Each change is signed once, by an author key of the author’s DID. Anyone can check the signatures against that DID’s own history.',
    /** Each entry commits to the hash of the one before it. */
    chainLabel: 'Previous entry',
    genesisLabel: 'First entry',
    versionLabel: 'Version',
    signedBy: 'signed by',
    unsigned: 'unsigned',
    /** Creator entries: the authenticity claim about what the work IS. */
    authenticityTitle: 'Signed history',
    /** Holder entries: chain of custody; can add to the story, never define the work. */
    custodyTitle: 'Notes from owners',
    heldBy: 'Held by',
    unverifiedAuthor: 'unverified author'
  },
  inspector: {
    previewAlt: 'Preview of your file',
    fileLabel: 'File',
    versionLabel: 'Version',
    fingerprintLabel: 'File fingerprint',
    signaturesLabel: 'Signed records',
    identityLabel: 'Original ID',
    webLabel: 'Web ID',
    bitcoinLabel: 'Bitcoin ID',
    provenanceTab: 'Record details',
    resourceTab: 'File',
    emptyState: 'Create an Original to view its record and file.'
  },
  /**
   * The completion screen, per tier (R8). Both halves used to be one block, so
   * a simulated run ended on "Anchored. Inscribed on satoshi <n> in tx <id>"
   * beside a mempool.space link — a specific fabricated claim about a specific
   * satoshi and a specific transaction, neither of which exists.
   */
  done: {
    real: {
      lead: 'Sent to Bitcoin.',
      beforeSatoshi: 'The record is intended for Bitcoin unit',
      beforeTx: 'in transaction',
      after: 'Check the Bitcoin network to confirm that the transactions and recorded history have been accepted.',
      explorerLabel: 'View transaction on mempool.space'
    },
    simulated: {
      lead: 'Simulation finished.',
      beforeSatoshi: 'The simulation returned Bitcoin unit',
      beforeTx: 'and transaction id',
      after:
        'Neither exists: nothing was broadcast and no Bitcoin was spent. Your signed history is real; the Bitcoin step was simulated.'
    }
  },
  resolved: {
    heading: 'Signed history—available on this site',
    /**
     * Signed-out heading. Publishing needs sign-in (#976 B5), so a signed-out
     * history is only in this page; see `hosting.temporaryNote`.
     */
    temporaryHeading: 'Signed history—in this page only',
    resolvedBadge: 'Available ✓',
    pendingBadge: 'Available on the published site',
    linkLabel: 'Open the signed history',
    note: 'Your published history was opened successfully. Follow the link to inspect it.'
  },
  /** Explicit local chain, separately labelled from the public networks. */
  regtest: {
    subhead: 'The final step inscribes on local Bitcoin regtest using test coins.',
    done: 'Publication broadcast on local Bitcoin regtest.',
    notice: 'Local regtest · test coins only. This run uses your local Bitcoin Core and ord services.',
    signInPrompt: 'Sign in to add to Bitcoin on your local Bitcoin regtest network.',
    stepDescription: 'Inscribes the published Original onto a satoshi on local Bitcoin regtest. Fund the displayed bcrt address with local test coins.',
  },
  testnet4: {
    signInPrompt: 'Sign in to add to Bitcoin on Bitcoin testnet4 — your own key signs it.',
    stepDescription:
      'Adds your Original to Bitcoin testnet4, a test network. Your key signs it, and a test funding service supplies coins with no monetary value.',
    yourKeyNote: 'Your Turnkey key signs this Bitcoin record in your browser. The server never sees a private key; funding comes from a testnet4 faucet (worthless tBTC).',
    faucetEmpty: 'The testnet4 faucet is temporarily out of funds — try again in a bit.',
    fundingFailed: 'The testnet4 funding request didn’t come through. Try the Add to Bitcoin step again in a moment — nothing has been spent.'
  },
  session: {
    expiredHeading: 'Your signing session expired',
    expiredBody:
      'Your browser’s signing key has expired, so nothing can be signed right now. Sign in again to get a fresh one — your Original, and any BTC already sitting at your deposit address, are untouched and waiting.',
    missingBody:
      'You’re signed in, but this browser has no signing key for your account — sign in again to get one. Nothing is lost: your Original is still available on the web, and any BTC at your deposit address is still yours.',
    // Deliberately does NOT offer "sign in again": this state is reached
    // because signing in is what failed. Promising a retry that cannot work is
    // the failure mode this string exists to avoid.
    unavailableHeading: 'Signing is unavailable right now',
    unavailableBody:
      'Signing isn’t working on this site right now, so adding work to Bitcoin is paused — this is on our end, not something you can fix by signing in again. Nothing is lost: your Original is still available on the web, and any BTC at your deposit address stays yours, at your own address, under your own key.',
    // Replaces unavailableBody when this browser refused a foreign-key token (#494); no retry offered, it would meet the same key.
    boundKeyMismatchBody:
      'This browser refused to finish signing in: the sign-in token it was handed names a signing key this browser does not hold. That should never happen, so rather than let an unknown key sign for your account, nothing was installed and adding work to Bitcoin is paused. Please tell us before you send any BTC. Your Original is still available on the web, and any BTC already at your deposit address stays yours, at your own address, under your own key.',
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
    heading: 'Pay to add your Original to Bitcoin',
    signInPrompt: 'Sign in to add your Original to Bitcoin. Your signing key approves it, and your BTC pays for it.',
    sendPrefix: 'Send at least',
    sendSuffix: 'of BTC to your deposit address. One payment or several will work. We use the confirmed payments needed to cover the cost, starting with the largest. Change and the Bitcoin record return to the same address.',
    addressLabel: 'Your deposit address',
    // The redesign (see DepositPanel): the action comes first and the full
    // R27 text moves into an always-present <details> below it. These two
    // lines are what stays visible without interaction — the purpose, and the
    // SUBSTANCE of the two money risks. The long-form lines below are not
    // replaced by them; they are still rendered, in full, on the same screen.
    purposeShort:
      'Covers Bitcoin network fees for two transactions, plus 546 sats (small units of Bitcoin) to hold the record. Change returns to this address.',
    riskSummary:
      'There is no withdrawal or refund. Unspent BTC stays at this address and can only be used to add another Original here. Network fees cannot be reversed, including by us. Send the quoted amount rather than a round number you would want back.',
    detailsSummary: 'How this works — the address, your key, and closing the tab',
    copyAddress: 'Copy',
    copiedAddress: 'Copied',
    copyAddressAria: 'Copy your deposit address',
    openInWallet: 'Open in wallet',
    openInWalletHint: 'Opens your Bitcoin wallet with the address and amount already filled in.',
    scanHint: 'Or scan to pay from your phone',
    // Between sending and confirming, a creator has no way to tell whether we
    // can see their money — and that is the worst moment to say nothing.
    pendingSeenSuffix: 'received by the Bitcoin network—waiting for one confirmation.',
    pendingViewLink: 'View transaction',
    // The funded state. Previously the panel said "Send at least N sats" even
    // once the deposit covered the cost, so a creator who had already paid was
    // still being told to pay and had no idea the next move was theirs.
    fundedHeading: 'Funded—ready to add to Bitcoin',
    fundedBody: 'Your deposit covers the cost. Use “Add to Bitcoin” to continue.',
    balanceLabel: 'Your deposit balance',
    balanceNeeded: 'needed to add this Original',
    addMoreSummary: 'Add more funds, or see the deposit address',
    // The commit landed but the reveal did not propagate. The inscription is
    // NOT on chain yet, and saying "inscribed" here is the same dishonesty as
    // telling someone to sign in again when signing in is what failed.
    commitOnlyHeading: 'First transaction sent—waiting for confirmation',
    // The sat is decided by the commit's first input, so it IS known already;
    // the inscription that will ride on it is not on chain yet.
    commitOnlySatPrefix: 'The record is intended for Bitcoin unit',
    // The commit txid is the ONE thing that lets someone watch their own money
    // land. Withholding it while telling them to wait is what made this step
    // feel like nothing happened.
    commitOnlyTxLabel: 'Funding transaction:',
    commitOnlyFeeLabel: 'paid at',
    commitOnlyTrackLink: 'Track it on Your Originals',
    commitOnlyRevealPending:
      'The transaction carrying your Original is signed and saved. It is sent automatically once the funding transaction confirms.',
    commitOnlyBody:
      'Your funding transaction has been sent. The second transaction carries your Original. It has not reached the network yet, but is signed and saved on our side. It is sent automatically once the first confirms. You do not need to pay again. Follow its progress on Your Originals.',
    balanceReuse:
      'Unspent BTC stays at this address and can pay for another Original here. You will not need to deposit again while it covers the cost.',
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
      'Your payment may take longer because other transactions are paying higher fees. It is waiting for confirmation.',
    feeLowBumpable:
      'If your wallet has a “bump fee” or “speed up” option, this payment can be replaced. Two things to get right: take the increase from your change, never from the deposit amount, and aim for the rate below — Bitcoin makes a replacement pay for its own bandwidth on top of the original fee, so a small nudge is rejected outright.',
    feeLowUnbumpable:
      'Your wallet did not allow this payment to be replaced, so its fee cannot be raised here. Wait for confirmation.',
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
      'Several payments work too: the Bitcoin record spends what it needs, largest first, and leaves the rest at the address.',
    waiting: 'Waiting for your deposit…',
    detected: 'Deposit detected — waiting for one confirmation.',
    ready: 'Deposit confirmed—ready to add to Bitcoin.',
    needed: 'No confirmed deposit covering the fee yet — send BTC to your deposit address and wait for one confirmation.',
    // U15 — the pre-deposit disclosure, rendered above the address in every
    // state (first visit, top-up, and a return visit where the address was
    // already issued). Mechanics only: who signs, where the key lives, what
    // happens to a balance that is never spent. The previous line here
    // ("You own the keys, the change, and the inscribed sat — nothing is
    // custodied") was a legal characterisation of a contested arrangement,
    // printed directly above the address a stranger sends mainnet BTC to.
    purpose:
      'This deposit pays the Bitcoin network fees for two transactions, plus 546 sats (small units of Bitcoin) to hold the record. Change returns to the same address.',
    addressOrigin:
      'The address is derived in this browser from your Turnkey wallet, and your account is bound to the first address it sends us — we don’t re-check it against Turnkey after that. Your browser signs the spend with that wallet’s key; the key is never sent to the server.',
    nonRefundable:
      'The network fee is spent the moment the transactions are broadcast, and Bitcoin transactions cannot be reversed. Nobody — us included — can undo or refund one.',
    unspentBalance:
      'There is no withdrawal or refund flow here. Unspent BTC stays at this address. The only way to move it through this site is to add another Original to Bitcoin, for as long as this service and its Turnkey organization are running. Send the quoted amount.',
    // R31 — said BEFORE they deposit, because that is the only moment we are
    // sure they are reading. It names the exact place the state will be, so
    // "close the tab" is a safe thing to do rather than a gamble.
    ifSomethingGoesWrong:
      'You can close this tab. If anything goes wrong on our side while you’re away — we lose our read of the network, or your Bitcoin record stalls — it’ll be waiting for you on your Your Originals page the next time you sign in. We don’t send email about it, so that page is where to look.',
    addressPending: 'Checking your deposit address with the server…',
    unavailableBadge: 'Fee estimate unavailable.',
    readUnavailableBadge: 'Can’t read your deposit address.',
    readBusyBadge: 'Deposit checks are temporarily limited.',
    feeUnavailable:
      'We can’t estimate the Bitcoin fee right now, so we’re not showing a deposit address. Your Original is still available on the web. Try again in a few minutes.',
    indexerUnavailable:
      'We can’t check your Bitcoin deposit right now, so we’re not showing an address or an old balance. Any BTC you sent is untouched at your address. Your Original is still available on the web. Try again in a few minutes.',
    indexerBusy:
      'The Bitcoin data service is limiting our requests, so we can’t check your deposit right now. Any BTC you sent is untouched at your address. Wait a few minutes and reload.',
    // A shortfall names the number: "deposit more" without an amount is what
    // leaves someone topping up blind. Composed by depositShortfallMessage.
    shortfallPrefix: 'Your confirmed deposits come to',
    shortfallMiddle: ', which is',
    shortfallSuffix:
      'short of the amount above. Send the difference to the same deposit address and wait for one confirmation — the Bitcoin record will spend both payments together.',
    // The ordinal classification is unavailable, so nothing is spendable.
    ordinalCheckUnavailable:
      'We can’t currently check whether the coins at your deposit address carry a Bitcoin record of their own, and we won’t spend a coin we can’t check — an Bitcoin unit holding the record spent as a fee is destroyed. Your BTC is untouched at your own address. Try again in a few minutes.',
    ordinalCheckBadge: 'Can’t check your coins for inscriptions.',
    // The check ran, but the address holds more outputs than one poll can
    // classify. The unchecked ones are simply not counted — a block explorer
    // will show more than the amount above, and this says why.
    ordinalCheckPartial: (unchecked: number) =>
      `${unchecked} smaller ${unchecked === 1 ? 'output' : 'outputs'} at your deposit address ${unchecked === 1 ? 'hasn’t' : 'haven’t'} been checked for inscriptions yet, so ${unchecked === 1 ? 'it isn’t' : 'they aren’t'} counted above. Your balance in a block explorer will read higher than the amount we can spend.`,
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
      'This site’s Bitcoin settings do not match. Adding Originals to Bitcoin is disabled, and no deposit address is shown, until the settings are fixed.',
    yourKeyNote: 'Your Turnkey signing key approves the transactions through your browser. Your deposit pays the fee. The private key is never sent to this site’s server.'
  },
  /**
   * The hosting layer, in visitor words. A raw `HttpHostingStorageAdapter.put
   * failed: 507` was reaching the page before this existed — a transport string
   * on screen, and a breach of the mechanical floor in GRADING.md.
   */
  /** Where signed-in work is kept on this device (#976 B, G2). */
  storage: {
    notKeptAcrossRestarts:
      'This browser can’t keep your work on this device, so it isn’t saved across restarts. Keep this page open, and download its evidence before you leave.'
  },
  hosting: {
    rateLimited:
      'Publishing is temporarily limited. Wait a few seconds and try again. Your signed Original is still in this tab.',
    unavailable:
      'We couldn’t publish your signed history. Your Original is still in this tab. Try again in a moment.',
    quotaFull:
      'Your account has used up its hosting space, so there’s no room for another version right now. Everything you’ve already published is untouched and still available.',
    // R7 — rendered in the PUBLISH step, before the button that publishes, not
    // only on the log that comes back afterwards. It is the one thing an
    // anonymous visitor cannot find out later.
    temporaryNote:
      'Signed out, this Original is signed by a key made in this page and discarded with it: nothing is saved, and it can’t be published or continued once you leave. Download its evidence to keep a copy anyone can verify. Sign in to publish it and keep editing.',
    /** The same caveat (G10) for a build where no one can publish yet. */
    temporaryNoteNoPublish:
      'Signed out, this Original is signed by a key made in this page and discarded with it: nothing is saved, and it can’t be continued once you leave. Download its evidence to keep a copy anyone can verify.'
  },
  /** Last resort: something we did not anticipate, said without a stack trace. */
  failure:
    'Something went wrong on our side. Nothing you’ve made is lost — your Original is still in this tab. Try that step again.',
  reset: 'Start a new Original'
};

export const realExample = {
  id: 'example',
  eyebrow: 'An example Original',
  headline: 'Check the history of “First Light”.',
  subhead:
    '“First Light” is an Original made with the Originals Protocol. Your browser opens its evidence package, checks the artwork against its signed history, and checks that each change was signed by its author’s DID. It is a local Original: these files do not claim it is published online or recorded on Bitcoin.',
  detailsLabel: 'View check details',
  recordDetailsLabel: 'View record details',
  checkLabels: {
    hash: 'The artwork matches the signed history',
    history: 'The signed history is intact back to its first entry',
    author: 'Each change is signed by the author’s DID'
  },
  pendingLabel: 'Verifying in your browser…',
  verifiedBadge: 'Verified in this tab',
  failedBadge: 'Verification incomplete',
  failNote:
    'Some checks could not finish here. You can download the evidence package and check it with `originals verify`.',
  artifactsLabel: 'Download the evidence package',
  artifactsHref:
    'https://github.com/onionoriginals/sdk/blob/main/apps/landing/public/example/first-light.originals.zip',
  fields: {
    identity: 'Original ID',
    author: 'Author DID',
    profile: 'Record format',
    issued: 'Recorded',
    validAsOf: 'Valid as of'
  },
  /** P7.10: a local Original is checked as of an entry, never as the latest version. */
  validAsOfNote: 'Valid as of this entry. A local Original is never shown as the latest version: only an Original recorded on Bitcoin can be.'
};

export const protocol = {
  id: 'protocol',
  eyebrow: 'How it works',
  headline: 'From private draft to published work.',
  subhead:
    'Create on your device. Publish on the web when you’re ready. Choose whether to record ownership on Bitcoin. Each step is added to the signed history.',
  migrationNote:
    'You can stop at any stage. Moving to the next stage cannot be undone.',
  // The signed history shows which author key approved each version (P5.3), not who made the work.
  standardsNote:
    'The signed history lets others check which signing key approved each version. It does not prove who originally made the work.',
  columns: [
    {
      layer: 'did:vh',
      name: 'Private draft',
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
      name: 'On the web',
      stage: '02 · Publish',
      cost: 'Hosting',
      rows: [
        ['Where it lives', 'Your website'],
        ['Who can see it', 'Anyone'],
        ['What it costs', 'Standard web hosting'],
        ['Best for', 'Catalogs, portfolios, discovery']
      ]
    },
    {
      layer: 'did:btco',
      name: 'On Bitcoin',
      stage: '03 · Add to Bitcoin',
      cost: 'BTC fees',
      rows: [
        ['Where it lives', 'The Bitcoin network'],
        ['Who can see it', 'Anyone'],
        ['What it costs', 'One-time network fees'],
        ['Best for', 'Recording and transferring ownership']
      ]
    }
  ]
};

export const developers = {
  id: 'developers',
  eyebrow: 'Developers',
  headline: 'Build Originals into your app.',
  subhead:
    'Use our developer tools to create, revise and verify Originals from your own app. Publishing to the web and adding to Bitcoin return with the next phases of the protocol.',
  bullets: [
    'Follow each step as it happens',
    'Verify evidence offline, with no account and no key',
    'Choose where to store files and signing keys',
    'Create signed records other apps can check'
  ],
  installLabel: 'Install',
  sdkNote:
    'This page uses @originals/sdk, available under the MIT license.',
  versionNote:
    'This page runs the Originals Protocol SDK, which ships under the `next` tag with its next release. Until that release is published, `next` installs the previous line.',
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
  tagline: 'A history that follows your work.',
  license: 'MIT licensed. Built by Aviary Tech.',
  bottomLeft: '© 2026 Aviary Tech · MIT License',
  bottomRight: 'Create → Publish → Add to Bitcoin',
  columns: [
    {
      title: 'Project',
      links: [
        { label: 'GitHub', href: 'https://github.com/onionoriginals/sdk' },
        { label: 'npm: @originals/sdk', href: 'https://www.npmjs.com/package/@originals/sdk' },
        { label: 'Protocol specification', href: 'https://github.com/onionoriginals/sdk/blob/main/specs/README.md' }
      ]
    },
    {
      title: 'Technical references',
      links: [
        { label: 'Identity standard', href: 'https://www.w3.org/TR/did-core/' },
        { label: 'Signed records standard', href: 'https://www.w3.org/TR/vc-data-model-2.0/' },
        { label: 'Web publishing standard', href: 'https://identity.foundation/didwebvh/' }
      ]
    },
    /**
     * R19. Legal links use root-relative hrefs the
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
        heading: 'Keys and your browser',
        body: [
          'Signed in, the keys behind your did:webvh identity and the Originals you author are Ed25519 keys in your Turnkey sub-organization, not in this browser. The identity key controls your DID and each published Original’s web address; a different key signs your Originals. This site publishes your DID log and never holds either private key.',
          'Signed out, neither key exists. The Original is signed by a key generated in the page and discarded with it: it is never stored or sent anywhere, and nothing can recover it, so that Original can’t be continued after you leave. Its evidence package holds no private key.',
          'The key authorising your Turnkey session is a non-extractable WebCrypto key in this browser’s IndexedDB — it can be asked to sign, but its private half cannot be read back out, by our code or anyone else’s. localStorage holds only the sub-organization id, the matching public key, and the expiry time.',
          'When you anchor an Original on Bitcoin, the signed transactions are also kept in this browser’s IndexedDB until the server confirms it has stored them, so a lost answer is retried with the same transactions rather than new ones. They pay only your own deposit address, and the copy is deleted once the server answers.'
        ]
      },
      {
        heading: 'What the server stores',
        body: [
          'The Originals you publish while signed in are written to a mounted volume: the did:webvh log, the Original’s signed history, and the bytes of the artwork itself, indexed under your Turnkey sub-organization id. Publishing is what makes them public — they are served at the exact URLs a DID resolver fetches, so anyone holding the DID can read them.',
          'When you inscribe, the signed commit and reveal transactions are stored before anything is broadcast. That copy is what lets the server finish an inscription for a browser tab that died between the two, and it stays on the volume afterwards — only a superseded pair that can no longer land has its signed transactions dropped. A per-account ceiling bounds how many of these records are kept, oldest spent ones first.',
          'When you anchor an Original on Bitcoin, the server keeps its own copy of the evidence you send with it: the Original’s signed history, your DID’s log, and the bytes of its files. It checks that copy before anything is broadcast, and keeps it, with the signed transactions, so it can finish or re-send an inscription later. Bitcoin itself holds only the signed history; that copy, and your own, are where the files live.',
          'The deposit address your account is bound to is stored too, along with the last balance read we could trust and any unresolved problem reading it, in a file named after your sub-organization id. That is what puts a warning on Your Originals after you have closed the tab.',
          'Signed out, nothing is published and the server stores nothing: publishing needs sign-in, and the Original stays in the page that made it.'
        ]
      },
      {
        heading: 'Server logs',
        body: [
          'Every point at which real Bitcoin moves or gets stuck writes one line to the server’s standard output, prefixed [landing][money], which the hosting platform’s log drain collects. Those lines are the only instrument we have for noticing that someone’s funds are stranded.',
          'A line carries the event name and a timestamp, your Turnkey sub-organization id, the Bitcoin network, the deposit address, sat amounts, transaction ids, the identifier of an Original being anchored, and a reason where something failed. The events are:'
        ],
        list: [
          'deposit_address_issued — an address is bound to your account for the first time',
          'deposit_seen — a confirmed balance appears at that address',
          'deposit_shortfall — the balance changed and still does not cover the quote',
          'deposit_read_failed — an address read, or the address binding, could not be trusted',
          'deposit_ordinal_check_unavailable — coins could not be checked for inscriptions, so none were offered as spendable',
          'deposit_ordinal_check_partial — the address held more outputs than one check covers; the unchecked ones were not offered as spendable',
          'inscribe_attempted — a signed pair passed validation and is about to broadcast',
          'inscribe_failed — a pair was refused or failed to broadcast',
          'inscribe_broadcast — a pair reached the network',
          'inscribe_reorg_reconfirmed — a confirmed reveal reconfirmed in a different block than before, which is what a Bitcoin reorg looks like',
          'deposit_balance_held — the hourly sweep found a bound address still holding confirmed sats',
          'deposit_balance_sweep — the roll-up of that sweep, including how many addresses hold a balance',
          'inscription_sweep_completed — we finished your inscription for you: your commit had confirmed, so we broadcast the reveal we already held, with nobody watching',
          'inscription_sweep_push_failed — that broadcast was refused by the network, and your inscription is still unfinished',
          'inscription_sweep_waiting — your commit had not confirmed yet, so we held the reveal and pushed nothing this hour',
          'inscription_sweep_lookup_failed — we could not read whether your commit had confirmed, so we pushed nothing',
          'inscription_sweep_raced — another check had already updated your inscription while we were pushing it, so we left that result alone rather than overwrite it',
          'inscription_sweep_unreadable — an account\u2019s inscription file could not be read, which is where a signed reveal lives',
          'originals_anchor_attempted — an Original\u2019s signed pair passed our checks and goes to the final check before broadcast',
          'originals_anchor_broadcast — that pair was stored and reached the network',
          'originals_anchor_broadcast_failed — the pair is stored but a broadcast failed; we re-send the same transactions later',
          'originals_anchor_refused — the pair was refused before anything was sent, with the reason',
          'originals_anchor_resumed — we re-sent a stored pair, the same transactions, after checking the Original again',
          'originals_anchor_sweep_failed — we could not read or re-send one Original\u2019s pair, so nothing was sent for it'
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
