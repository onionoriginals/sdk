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
   * assets … local CEL → did:webvh → did:btco') named the library and three DID
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
    { label: 'Explore', href: '/explore' },
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
  imprint: {
    eyebrow: 'For those who make things.',
    headline: ['MAKE IT.', 'ORIGINAL.'],
    promise: ['Your work has a beginning.', 'Give it a history that follows.'],
    note: 'Create privately. Publish when ready.',
    recordLabel: 'Originals / Mark No. 001',
    stamp: 'SIGNED ↗',
    filename: 'STUDY-001.SVG',
    recordTitle: 'A signed beginning.',
    illustrationNote: 'Example artwork',
    ribbon: 'FILE → HISTORY → ORIGINAL',
    historyLabel: 'The record keeps going.',
    historyNote: 'Example history / no live transactions',
    history: [
      { title: 'Created', body: 'The first signed record.' },
      { title: 'Revised', body: 'A new version linked to the last.' },
      { title: 'Published', body: 'A record others can inspect.' }
    ],
    closing: 'Make something worth remembering.'
  },
  eyebrow: 'Signed history · Recorded on Bitcoin',
  headline: 'A signed history of your work.',
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
    id: 'did:cel' as const,
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
    'Adding work to Bitcoin requires a funded account and Bitcoin support on this site. You can still create and publish your Original.',
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
      layer: 'did:cel',
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
  /** Live transaction fees depend on the complete CEL 3 publication. */
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
    entryLabels: { create: 'Created', migrate: 'Published', rotateKey: 'Signing key changed', update: 'Revised' } as Record<string, string>,
    title: 'History',
    empty: 'Your history starts here',
    emptyHint: 'Create an Original to see its signed history here.',
    emptyUpcoming: ['Create', 'Publish', 'Add to Bitcoin'],
    sourceNote: 'These signatures record changes approved by the signing key. Whether Bitcoin accepted the record is checked separately.',
    /** Each entry commits to the hash of the one before it. */
    chainLabel: 'Previous entry',
    genesisLabel: 'First entry',
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
    /** Anonymous logs live in the shared in-memory host store; see `hosting.temporaryNote`. */
    temporaryHeading: 'Signed history—available here for now',
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
      'Without signing in, your published history is stored in a shared demo area and removed after a couple of hours. Sign in before publishing to save it under your account for as long as this service runs.'
  },
  /** Last resort: something we did not anticipate, said without a stack trace. */
  failure:
    'Something went wrong on our side. Nothing you’ve made is lost — your Original is still in this tab. Try that step again.',
  reset: 'Start a new Original'
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
    cel: 'CEL event chain verifies back to the signed genesis'
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
          'Born as a signed genesis — a signed event log kept private, never hosted anywhere until published. The resource bytes were hashed and sealed into the very first event.'
      },
      publish: {
        title: 'Published',
        blurb:
          'Migrated to did:webvh: a signed version history went live at this origin, resolvable by anyone with the SDK — or curl.'
      },
      inscribe: {
        title: 'Inscribed',
        blurb:
          'The next step in the lifecycle: inscribing on a satoshi makes ownership transferable on Bitcoin — permanent, final, and platform-free. The reveal inscription carries the whole signed log in its own metadata, so from here the Original’s provenance survives even this service; a log that stops at did:webvh lasts only as long as this service hosts it.'
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
    // The reveal is signed and saved before it is broadcast, so its id exists
    // while the transaction does not. Say so rather than linking a 404.
    txNotBroadcastNote: 'Signed and saved, not yet broadcast — it goes out once the funding transaction confirms.',
    commitTxLabel: 'Funding transaction',
    pendingBadge: 'awaiting confirmation',
    confirmedBadge: 'confirmed on-chain',
    explorerLabel: 'View on mempool.space',
    commitExplorerLabel: 'View the funding transaction on mempool.space'
  }
};

export const realExample = {
  id: 'example',
  eyebrow: 'An example Original',
  headline: 'Check the history of “First Light”.',
  subhead:
    '“First Light” was created with Originals. Your browser checks the artwork against its signed record and checks the signatures in its history. These bundled files demonstrate those checks; they do not establish that the work is currently published online or recorded on Bitcoin.',
  detailsLabel: 'View check details',
  recordDetailsLabel: 'View record details',
  checkLabels: {
    hash: 'The artwork matches the signed record',
    log: 'The published history’s identity and signatures check out',
    cel: 'Signatures match the recorded history'
  },
  pendingLabel: 'Verifying in your browser…',
  checkFailDetails: {
    log: 'DID log did not verify, or is not the identity this asset migrated to',
    cel: 'CEL signatures did not verify, or attests a different identity'
  },
  verifiedBadge: 'Verified in this tab',
  failedBadge: 'Verification incomplete',
  failNote:
    'Some checks could not finish here. You can download the original files and use our developer tools to check them.',
  artifactsLabel: 'View the original files',
  artifactsHref:
    'https://github.com/onionoriginals/sdk/tree/main/apps/landing/public/example',
  fields: {
    identity: 'Original ID',
    published: 'Web ID',
    profile: 'Record format',
    issued: 'Recorded'
  }
};

// A second, separate Original: one the team actually funded and inscribed on
// Bitcoin mainnet — not the mock provider "First Light" above uses for its
// Bitcoin step. Its identifiers are public, so this checks them live against
// this deploy's own indexer where possible, and otherwise shows the last
// receipt the team independently verified themselves.
export const mainnetExample = {
  eyebrow: 'On Bitcoin',
  headline: 'An Original recorded on Bitcoin.',
  subhead:
    'The team paid to add this separate Original to Bitcoin. Its public record can be looked up on a Bitcoin transaction website.',
  pendingLabel: 'Checking Bitcoin…',
  liveBadge: 'Checked just now',
  retainedBadge: 'Showing the last saved check',
  trustNote:
    'Live checks use a third-party Bitcoin data service and depend on its accuracy. They do not independently check agreement across the Bitcoin network. When a live check is unavailable, including for signed-out visitors, we show the last receipt the team checked.',
  fields: {
    identity: 'Bitcoin ID',
    inscription: 'Record ID',
    sat: 'Bitcoin unit',
    resource: 'File on Bitcoin'
  },
  resourceOnChainNote: 'file contents found in the accepted record',
  resourceOffChainNote: 'file contents not found in this check',
  explorerLabel: 'View transaction on mempool.space',
  receiptLabel: 'View the saved evidence'
};

export const protocol = {
  id: 'protocol',
  eyebrow: 'How it works',
  headline: 'From private draft to published work.',
  subhead:
    'Create on your device. Publish on the web when you’re ready. Choose whether to record ownership on Bitcoin. Each step is added to the signed history.',
  migrationNote:
    'You can stop at any stage. Moving to the next stage cannot be undone.',
  // Generic CEL application provenance and DID-method identity are separate standards.
  standardsNote:
    'The signed history lets others check which signing key approved each version. It does not prove who originally made the work.',
  columns: [
    {
      layer: 'did:cel',
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
    'Use our developer tools to create, publish and add Originals to Bitcoin from your own app.',
  bullets: [
    'Follow each step as it happens',
    'Test Bitcoin steps without spending money',
    'Choose where to store files and signing keys',
    'Create signed records other apps can check'
  ],
  installLabel: 'Install',
  sdkNote:
    'This page uses @originals/sdk, available under the MIT license.',
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
  tagline: 'A history that follows your work.',
  license: 'MIT licensed. Built by Aviary Tech.',
  bottomLeft: '© 2026 Aviary Tech · MIT License',
  bottomRight: 'Create → Publish → Add to Bitcoin',
  columns: [
    {
      title: 'Project',
      links: [
        { label: 'Explore Originals', href: '/explore' },
        { label: 'GitHub', href: 'https://github.com/onionoriginals/sdk' },
        { label: 'npm — @originals/sdk', href: 'https://www.npmjs.com/package/@originals/sdk' },
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
          'inscription_sweep_unreadable — an account\u2019s inscription file could not be read, which is where a signed reveal lives'
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

export const explore = {
  eyebrow: 'The public collection',
  title: 'Every Original has a story.',
  intro: 'Discover work published with Originals. Open a piece to explore its signed history and the files it preserves.',
  searchLabel: 'Search published Originals',
  searchPlaceholder: 'A title, an Original, a controller key…',
  searchButton: 'Search',
  newest: 'Newest first',
  loading: 'Opening the collection…',
  loadingMore: 'Loading more Originals…',
  loadMore: 'Load more Originals',
  unavailable: 'The collection could not be loaded. Please try again.',
  retry: 'Try again',
  emptyTitle: 'The collection starts with an Original.',
  emptyBody: 'Published work will appear here. Create an Original to add your first piece.',
  noResults: 'No Originals match your search.',
  clear: 'Clear search',
  create: 'Create an Original',
  open: 'Explore Original',
  created: 'Created',
  file: 'File',
  files: 'files',
  back: 'All Originals',
  missing: 'This Original is not available in the public collection.',
  resources: 'Open the original file',
  history: 'Signed history',
  controller: 'Controller key',
  identity: 'Original identity',
  hostedIdentity: 'Published identity',
  log: 'WebVH version history',
  cel: 'Cryptographic event log',
  bitcoin: 'Bitcoin inscription',
  bitcoinHint: 'Satoshi to verify',
  checking: 'Checking the signatures and file…',
  checked: 'Hosted history and primary file verified',
  incomplete: 'Verification incomplete',
  checkNote: 'These checks verify the hosted signatures and primary file in your browser. Any linked Bitcoin publication is checked against fresh public Bitcoin data.',
  openHistory: 'Inspect the signed artifacts',
};
