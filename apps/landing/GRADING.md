# Craft bar — how "Stripe/Linear tier" is measured here

The done-bar requires that a fresh-context grader, viewing the rendered page
next to stripe.com and linear.app screenshots, cannot identify this page as
the lower-craft one. That judgment is subjective, so we decompose it into
measurable checks plus a blind side-by-side. A cycle passes only if **all
mechanical checks pass** and the **blind judgment does not single us out**.

## A. Mechanical checks (scripted or DOM-inspectable)

Typography
- ≤ 2 font families (Inter Variable + JetBrains Mono).
- Every rendered font-size belongs to the token scale
  {12, 13, 15, 17, 21, 28, 36, 48, 60}px (±1px for clamp() interpolation).
- Display line-height ≤ 1.2; body line-height ≥ 1.5.
- Headline letter-spacing negative (-0.02em to -0.035em).
- Body copy line length 45–75ch.

Spacing & layout
- Layout-level paddings/margins/gaps (≥ 8px) are multiples of 4px.
  Micro-components (pills, chips, icon gaps, border-overlap offsets) may
  use a 2px sub-grid — the same convention Linear and Stripe use for
  sub-8px optical spacing.
- One container width (1120px) used by every section.
- Vertical section rhythm consistent across content sections after the
  hero: 96px mobile / 128px desktop (±8px). (The hero has its own rhythm,
  as on stripe.com/linear.app.)
- No horizontal overflow at 375px or 1440px.

Color
- Body text contrast ≥ 4.5:1 against its background; large text ≥ 3:1.
- No pure #000 or #fff surfaces.
- One primary accent (amber) + three layer hues; grays from tokens only.

Motion
- All transitions/animations 120–700ms with non-linear easing.
  (Exception: caret-blink idiom may use the platform-standard ~1s step
  cadence, as terminals, VS Code, Stripe and Linear all do; it must pause
  under reduced-motion.)
- Entrance staggers ≤ 100ms between siblings.
- `prefers-reduced-motion: reduce` disables all movement.
- No layout shift after first paint (no CLS from fonts/images).

Interaction details
- Every interactive element has visible hover AND :focus-visible states.
- Cursor affordances correct (pointer on buttons/links, not-allowed on
  disabled).
- Copy buttons give feedback within 200ms.

Mechanical floor (from the done-bar)
- Zero console errors/pageerrors on load and through a full demo run at
  375px and 1440px.
- Interactive < 3s on throttled network (1.6 Mbps down / 150ms RTT,
  Playwright CDP emulation): first paint + hero CTA clickable. The SDK
  chunk may still be loading (it lazy-loads), but the page itself must be
  usable.

## B. Blind side-by-side protocol

1. Screenshot our hero + one content section at 1440×900 @2x.
2. Present to a fresh-context judge alongside equivalent-crop screenshots
   of stripe.com and linear.app (fetched live if the proxy allows; else the
   judge relies on their knowledge of those sites' craft).
3. Ask: "One of these pages was built by a lower-craft team. Which one, and
   why?" — If the judge picks ours (or picks ours with specific,
   fixable evidence), the cycle fails and the evidence becomes the fix list.

## C. Content checks (done-bar restated as testable questions)

- Founder test: from hero + first section only (30s exposure), the grader
  can state, unprompted, (a) what the protocol does, (b) why it matters.
- Developer test: grader can name did:peer / did:webvh / did:btco, state
  the migration direction, and find install + quickstart within one scroll
  from the developers anchor (or hero install chip counts at zero scrolls).
- Demo test: grader completes create → publish → inscribe and confirms via
  devtools console (`[originals-sdk]` logs and `window.__originalsDemo`)
  that events came from real SDK calls, not canned JSON.
