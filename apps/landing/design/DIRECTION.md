# Originals landing: direction

## Brief (self-authored from the request, the repo and the logo direction)

- **What:** a redesign of the Originals landing page (`apps/landing`, Vite + React, plain CSS tokens). The shared nav, footer and interior pages (Explore, Your Originals, legal) inherit the new skin.
- **Who:** creators first (illustrators, writers, designers), developers second.
- **The one job:** in ten seconds, understand "Originals gives my work a signed history" and press **Make your first Original** (the in-page demo).
- **Feel:** luminous, rare, exact.
- **References from outside the web:** the diamond-ring moment of a total solar eclipse; a jeweller's loupe; an observatory at night.
- **Given:** the logo direction (eclipse ring, white limb, amber "diamond" flare, expanded tracked wordmark on near-black). Real copy in `src/content.ts` (claims are pinned by tests). Real data: the bundled "First Light" example and the mainnet receipt.
- **Image generation:** none used.

## Current

The "Imprint" look: vermilion colour-field nav and hero, "MAKE IT. ORIGINAL." in Inter 800, a rotated ink card with a split-O mark and a "SIGNED ↗" stamp, a paper marquee ribbon, ink body, paper Developers section, Georgia italic closing line.
History row: `site|printed|colour-field|grotesque|red|illustration|scroll-story`.

Scan before: 4 FAILs (text at 8–9px, 3.94:1 contrast of ink on vermilion across nav and hero, a coloured glow shadow), 17 type sizes, 13 mono eyebrows, four hue families, 89–93 character lines.

**Keep list:** nav links (Explore, Why Originals, Try it, How it works, Developers), GitHub, Sign in + login modal, Start CTA, Your Originals for signed-in users, identity panel, primary CTA → `#demo`, quiet link → `#example`, the three-event history, Why, Demo (all tiers and states), Real example verification + mainnet receipt, How it works (three stages, costs, both notes), Developers (install, docs link, version note), footer columns and legal links, every claim guard in `content.claims.test.ts`.

## Category default refused

Provenance / NFT / "creator economy on Bitcoin" sites share: a dark launch page with a purple-to-orange gradient, a grid of NFT thumbnails, "own your art" slogans, wallet-connect buttons, and a stats strip. Category colour cliché: Bitcoin orange on black with neon. Slop faces this brief falls into naturally: **The Launch Page** (dark, glow, centred) and **The Dark Dev Tool** (zinc, mono everywhere, pills). Refused: centred hero, gradient text, logo strip, KPI strip, tinted feature-card icons, mono eyebrows over every section, three layer hues doing three jobs.

The only light on the page is the eclipse, a scene, not a button glow.

## Three concepts

- **A (nature): "Originals is the diamond ring of a total eclipse: one bright, exact instant that everyone can see and no one can redo."** Dark ground, Archivo Expanded, amber, corona of light streaks (canvas), scroll-story. **Chosen.**
- **B (printed): "Originals is a gem grading report."** Cool white, Newsreader + Plex Mono, seal blue, the record as data with a self-drawing facet diagram, document. Lost: correct and calm, but it is any certificate or fintech page; with the logo on it, nothing connects.
- **C (place): "Originals is a planetarium dome show."** Ultramarine field, Big Shoulders, star yellow, dot-matrix ring, poster. Lost: loud and memorable, but the dotted ring reads as a halftone "O", not an eclipse, and blue/yellow fights the amber brand mark.

From B, kept: the hero carries the real record ("First Light" events with exact UTC times) as evidence. From C, kept: the confidence to let the scene take half the first screen.

History row: `site|nature|dark|expanded|orange|colour-material|scroll-story` (clear against history and the old look).

## Tokens (src/design/eclipse.css)

Colour, dark only (the logo is a night scene; light mode declined on purpose; `color-scheme: dark`):

| Role | Value | Source |
|---|---|---|
| ground | `#07080b` | the moon's disc, the logo ground |
| ground-raised | `#0e1015` | the sky just outside totality |
| ground-overlay | `#151821` | |
| ink | `#f3f1ec` | the white limb of the ring |
| ink-2 | `#aeb2bc` (8.9:1) | |
| ink-3 | `#8a8f9b` (5.9:1) | |
| rule | `#ffffff1a` / strong `#ffffff33` | |
| accent | `#ffa63d` | the diamond flare. One job: the act of signing and anchoring (primary action marks, "now" in a history, the Bitcoin stage) |
| accent-text | `#ffb866` | |
| ok | `#7fd9a8` | verification state only, always with a word |

Layer colours collapse: draft and web are ink tints distinguished by word and position; Bitcoin is the accent.

Type:
- **Archivo** (variable, `wdth` 62–125, `wght` 100–900), because the logo's wordmark is an expanded grotesque and Archivo's width axis gives that voice at 125% for display and a sober 100% text face from the same family.
- **JetBrains Mono**, kept on purpose for data only (DIDs, hashes, timestamps): the demo already shows 60-character identifiers in it and it stays narrow enough not to wrap them. Never for labels.

Scale: display `clamp(44px, 5.6vw, 92px)` expanded 800 uppercase; h2 `clamp(30px, 3.4vw, 52px)` expanded 780 uppercase; h3 22px; body 17px; small 15px; meta 13px.
Wordmark only: 0.32em tracking, uppercase.

Space: 4, 8, 12, 16, 24, 40, 64, 104, 168. Radius family: round things are round (buttons are pills, the ring motif), objects 14px, inputs 10px. Max width 1320px; reading measure 62ch.

## Richness

The eclipse, drawn in code: a black disc, a white limb, a corona of thin amber streaks rising from the edge, brightest under the diamond. One hand, one light source (upper right, like the logo). The diamond is a four-point star with unequal arms, the horizontal longer.

## Grammar (scroll-story)

1. **Hero**: what is it, what do I do? Headline, one sentence, the CTA; the eclipse; "First Light"'s real event list as evidence.
2. **The record keeps going**: what is a history? Three events on a line that ends at the light.
3. **Why it matters**: why should I care? Three statements as type, no boxes.
4. **Make an Original**: can I try it? The working demo.
5. **An example Original**: show me a real one. In-browser verification.
6. **How it works**: what does each stage mean and cost?
7. **Developers**, then the footer, which ends on the logo lockup.

## Signature: "second contact"

- **Trigger:** first paint of the hero.
- **Frames:** 0 ms: dark disc, faint corona. 0–1800 ms: the white limb draws itself around the disc anticlockwise, ending at 1:30 (ease-out cubic). 1500–2200 ms: at that point the diamond blooms: warm halo, then the four arms extend. Then the loop: corona streaks drift outward and fade (about 9 s per streak), the diamond breathes ±6% over about 8 s. The pointer pulls the diamond a few degrees around the limb (lerp 0.06, clamped ±4°) and it returns to rest when the pointer leaves.
- **Reduced motion:** the final frame, drawn once: full ring, diamond open, corona still.
- **Off-screen / hidden tab:** paused.

## Voice

Talks like a good framer or archivist: plain, exact about what is proven and what is not, never hype.

## Content

Hero:
- H1: **Give your work a history.**
- Lede: Keep a signed record of your work as it changes. Start with a private draft, publish it for others to check, and choose whether to record ownership on Bitcoin.
- Primary: **Make your first Original** → `#demo`. Quiet link: **See one that already exists** → `#example`.
- Evidence caption: “First Light”, an example Original · Created 6 Sep 2026, 15:34:21 UTC · Published to the web 6 Sep 2026, 15:34:21 UTC · Bitcoin: not added (that is its owner’s choice).

Record section:
- H2: **The record keeps going.**
- Line: Every new version is signed and linked to the one before. Example history, not live transactions.
- Events: Created (The first signed record.) · Revised (A new version linked to the last.) · Published (A record others can inspect.)

All later sections: existing copy in `content.ts`, unchanged except eyebrows reduced (see build).

Footer closing line: **Make something worth remembering.**
