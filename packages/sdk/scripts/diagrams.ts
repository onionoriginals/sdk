#!/usr/bin/env bun
/**
 * The SDK diagrams in `docs/diagrams/`, drawn as plain SVG (no HTML inside),
 * so GitHub and npm show them as images. Each follows the reader's light or
 * dark setting. Text does not wrap in SVG: every line break is set here.
 *
 *   bun scripts/diagrams.ts     # rewrite docs/diagrams/*.svg
 *
 * `tests/unit/originals/diagrams.test.ts` fails when the files differ from
 * what this script draws, or when an API name drawn (`data-api`) is no longer
 * exported, or a report part drawn (`data-report`) is no longer reported.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const W = 800;
const SANS = `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif`;
const MONO = `ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace`;

// GitHub's light and dark palettes, so the images sit well on either.
const STYLE = `
svg{--fg:#1f2328;--muted:#59636e;--card:#f6f8fa;--border:#d1d9e0;--code:#eaeef2;--accent:#0969da;--yes:#1a7f37;--no:#cf222e;--warn:#9a6700;--warnbg:#fff8c5;--author:#8250df;--zip:#1b7c83;--web:#1a7f37;--btc:#bc4c00}
@media (prefers-color-scheme: dark){svg{--fg:#e6edf3;--muted:#9198a1;--card:#151b23;--border:#3d444d;--code:#262c36;--accent:#4493f8;--yes:#3fb950;--no:#f85149;--warn:#d29922;--warnbg:#2e2614;--author:#ab7df8;--zip:#39c5cf;--web:#3fb950;--btc:#f0883e}}
text{font-family:${SANS};font-size:12px;fill:var(--fg)}
.mono{font-family:${MONO};font-size:11px}
.muted{fill:var(--muted)}
.small{font-size:11px}
.h{font-size:15px;font-weight:600}
.b{font-weight:600}
.cap{font-size:10.5px;font-weight:600;letter-spacing:.06em;fill:var(--muted)}
.accent{fill:var(--accent)}
.yes{fill:var(--yes)}
.no{fill:var(--no)}
.card{fill:var(--card);stroke:var(--border)}
.code{fill:var(--code)}
.dash{stroke:var(--border);stroke-dasharray:4 3;fill:none}
.arrow{fill:var(--accent)}
`.trim();

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

interface TextOptions { anchor?: "middle" | "end"; api?: string; report?: string; style?: string }

/** One line of text at baseline `y`. `api` names what it draws, for the test. */
function t(x: number, y: number, s: string, cls = "", o: TextOptions = {}): string {
  const attrs = [
    `x="${x}"`, `y="${y}"`,
    cls ? `class="${cls}"` : "",
    o.anchor ? `text-anchor="${o.anchor}"` : "",
    o.api ? `data-api="${o.api}"` : "",
    o.report ? `data-report="${o.report}"` : "",
    o.style ? `style="${o.style}"` : "",
  ].filter(Boolean).join(" ");
  return `<text ${attrs}>${esc(s)}</text>`;
}

/** Lines of text from baseline `y`, `step` apart. */
const lines = (x: number, y: number, list: string[], cls = "", step = 16) => list.map((s, i) => t(x, y + i * step, s, cls)).join("");

function box(x: number, y: number, w: number, h: number, cls = "card", style = ""): string {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" class="${cls}"${style ? ` style="${style}"` : ""}/>`;
}

const arrow = (x: number, y: number) => `<path class="arrow" d="M${x} ${y - 6} L${x + 8} ${y} L${x} ${y + 6} Z"/>`;
const hline = (x1: number, x2: number, y: number, cls = "dash", style = "") => `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" class="${cls}"${style ? ` style="${style}"` : ""}/>`;

function svg(h: number, title: string, desc: string, body: string[]): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" viewBox="0 0 ${W} ${h}" role="img" aria-labelledby="title desc">`,
    `<title id="title">${esc(title)}</title>`,
    `<desc id="desc">${esc(desc)}</desc>`,
    `<style>${STYLE}</style>`,
    ...body,
    `</svg>`,
    "",
  ].join("\n");
}

/** A call in a code-coloured chip: its name, and a short note right-aligned. */
function chip(x: number, y: number, w: number, name: string, note: string, api: string, highlight = false): string {
  return [
    box(x, y, w, 20, "code", highlight ? "stroke:var(--accent);stroke-width:1.5" : ""),
    t(x + 8, y + 14, name, "mono", { api }),
    note ? t(x + w - 8, y + 14, note, "muted small", { anchor: "end" }) : "",
  ].join("");
}

// ------------------------------------------------------------------ guided

function guided(): string {
  const out: string[] = [t(0, 14, "THE GUIDED PATH · EVERYTHING FROM @originals/sdk", "cap")];
  const BW = 188, G = 16, y0 = 26, BH = 238;
  const steps: Array<{ title: string; code: Array<[string, string]>; does: string[]; get: string[]; mono: boolean }> = [
    { title: "Create", code: [["OriginalsStudio.start()", "OriginalsStudio.start"], ["studio.create({…})", "OriginalsStudio#create"]],
      does: ["Makes a did:vh author", "and its key. Hashes the", "bytes, signs entry 1."], get: ["app: a handle at", "checkpoint 1"], mono: false },
    { title: "Add a version", code: [["app.addVersion({", "OriginalHandle#addVersion"], ["  bytes, label, note })", ""]],
      does: ["Hashes the new bytes,", "links entry 2 to entry 1,", "adds label + note, signs."], get: ["{ version: 2,", "  label, note }"], mono: true },
    { title: "Export", code: [["app.export()", "OriginalHandle#export"]],
      does: ["Packs both logs and the", "bytes into one ZIP. No", "private key goes in."], get: ["my-app-v2.originals.zip"], mono: true },
    { title: "Verify", code: [["studio.verify(bytes)", "OriginalsStudio#verify"], ["npx originals verify", ""]],
      does: ["Reads the ZIP the way a", "stranger would: offline,", "no key, no local state."], get: ["verified, versions,", "report"], mono: true },
  ];
  steps.forEach((s, i) => {
    const x = i * (BW + G);
    out.push(box(x + 0.5, y0 + 0.5, BW - 1, BH));
    out.push(t(x + 12, y0 + 20, `STEP ${i + 1}`, "cap", { style: "fill:var(--accent)" }));
    out.push(t(x + 12, y0 + 40, s.title, "h"));
    out.push(box(x + 10, y0 + 50, BW - 20, 40, "code"));
    s.code.forEach(([code, api], j) => out.push(t(x + 16, y0 + 66 + j * 16, code, "mono", api ? { api } : {})));
    out.push(t(x + 12, y0 + 110, "SDK DOES", "cap"));
    out.push(lines(x + 12, y0 + 127, s.does, "muted"));
    out.push(hline(x + 12, x + BW - 12, y0 + 172));
    out.push(t(x + 12, y0 + 190, "YOU GET", "cap"));
    out.push(lines(x + 12, y0 + 207, s.get, s.mono ? "mono" : ""));
    if (i < steps.length - 1) out.push(arrow(x + BW + 4, y0 + 36));
  });

  const y1 = 294, B2 = 179, G2 = 28, H2 = 84;
  out.push(t(0, y1, "WHAT GETS BUILT", "cap"));
  const built: Array<{ title: string; text: string[]; color?: string }> = [
    { title: "Author DID log", text: ["did:vh, made by start().", "Its author key signs", "every entry."], color: "--author" },
    { title: "Entry 1 · v1", text: ["name, resource digest", "label: optional"] },
    { title: "Entry 2 · v2", text: ["new digest, linked to", "entry 1. label: \"New UI\",", "note: what changed"] },
    { title: "Evidence ZIP", text: ["asset log, author log", "and resource bytes"], color: "--zip" },
  ];
  built.forEach((b, i) => {
    const x = i * (B2 + G2);
    out.push(box(x + 0.5, y1 + 12.5, B2 - 1, H2, "card", b.color ? `stroke:var(${b.color});stroke-width:1.5` : ""));
    out.push(t(x + 12, y1 + 34, b.title, "b"));
    out.push(lines(x + 12, y1 + 52, b.text, "muted"));
    if (i < built.length - 1) out.push(arrow(x + B2 + 10, y1 + 12 + H2 / 2));
  });
  out.push(t(0, y1 + 120, "Labels and notes are signed metadata of the entry that adds the version: metadata[\"originals:version\"] (PROVISIONAL).", "muted small"));

  const y2 = y1 + 134;
  out.push(box(0, y2, W, 32, "card", "fill:var(--warnbg);stroke:none"));
  out.push(`<rect x="0" y="${y2}" width="3" height="32" style="fill:var(--warn)"/>`);
  out.push(`<text x="14" y="${y2 + 20}"><tspan class="b">Verified ≠ current.</tspan> Until it's anchored on Bitcoin, an Original is valid only as of its checkpoint.</text>`);
  return svg(y2 + 33, "The guided path: Create, Add a version, Export, Verify",
    "Four calls from @originals/sdk. OriginalsStudio.start and studio.create make a local did:vh author and sign entry 1. app.addVersion with bytes, a label and a note signs entry 2, linked to entry 1. app.export packs the asset log, the author's DID log and the resource bytes into an evidence ZIP with no private key. studio.verify, or npx originals verify, reads the ZIP offline and returns verified, the versions and the report. A verified Original is not current until it is anchored on Bitcoin.",
    out);
}

// ------------------------------------------------------------------ layers

function layers(): string {
  const out: string[] = [t(0, 14, "WHERE AN ORIGINAL LIVES · IT ONLY MOVES RIGHT", "cap")];
  const LW = 248, G = 28, y0 = 26, LH = 330, CW = LW - 20;
  type Chip = [string, string, string, boolean?];
  const lanes: Array<{ title: string; sub: string; color: string; groups: Array<{ cap?: string; chips: Chip[] }>; notes: string[]; from: string }> = [
    { title: "Local", sub: "your store, your author", color: "--accent", from: "@originals/sdk",
      groups: [{ chips: [
        ["create", "v1, genesis", "OriginalsSDK#create", true],
        ["edit", "new version, metadata", "OriginalsSDK#edit", true],
        ["deactivate", "terminal", "OriginalsSDK#deactivate"],
        ["package", "→ evidence ZIP", "OriginalsSDK#package", true],
        ["load", "verify a ZIP", "OriginalsSDK#load", true],
        ["import", "take in a ZIP", "OriginalsSDK#import"],
        ["carry", "log inside the file", "OriginalsSDK#carry"],
      ] }],
      notes: ["Store: MemoryStore, or", "FileStore in Node."] },
    { title: "Web", sub: "published on a did:webvh domain", color: "--web", from: "@originals/sdk",
      groups: [
        { chips: [
          ["publish", "adds the alias", "OriginalsSDK#publish"],
          ["hostedFiles", "files to serve", "root:hostedFiles"],
          ["loadPublished", "reader's check", "OriginalsSDK#loadPublished"],
        ] },
        { cap: "SHARED HOST · SEVERAL SIGNERS", chips: [
          ["submit", "host accepts or refuses", "OriginalsSDK#submit"],
          ["sync", "pull the host's log", "OriginalsSDK#sync"],
          ["reconcile", "redo a refused change", "OriginalsSDK#reconcile"],
        ] },
      ],
      notes: ["An alias counts only if it", "points back to the Original."] },
    { title: "Bitcoin", sub: "anchored to one sat, once", color: "--btc", from: "@originals/sdk/originals/bitcoin",
      groups: [{ chips: [
        ["anchor", "the anchoring entry", "OriginalsSDK#anchor"],
        ["prepareEntryInscription", "", "bitcoin:prepareEntryInscription"],
        ["submitEntryInscription", "", "bitcoin:submitEntryInscription"],
        ["catchUp", "what to do next", "bitcoin:catchUp"],
        ["readAnchored", "what Bitcoin shows", "bitcoin:readAnchored"],
        ["transferHandoff", "to a new holder", "bitcoin:transferHandoff"],
      ] }],
      notes: ["After anchoring, a change", "counts only once it's", "inscribed on that sat."] },
  ];
  lanes.forEach((lane, i) => {
    const x = i * (LW + G);
    out.push(box(x + 0.5, y0 + 0.5, LW - 1, LH));
    out.push(`<rect x="${x + 0.5}" y="${y0 + 0.5}" width="${LW - 1}" height="4" rx="2" style="fill:var(${lane.color})"/>`);
    out.push(t(x + 12, y0 + 28, lane.title, "h"));
    out.push(t(x + 12, y0 + 45, lane.sub, "muted small"));
    let y = y0 + 58;
    for (const g of lane.groups) {
      if (g.cap) { out.push(t(x + 12, y + 14, g.cap, "cap")); y += 22; }
      for (const [name, note, api, hi] of g.chips) { out.push(chip(x + 10, y, CW, name, note, api, hi === true)); y += 26; }
    }
    out.push(lines(x + 12, y0 + 262, lane.notes, "muted small", 15));
    out.push(hline(x + 12, x + LW - 12, y0 + 302));
    out.push(t(x + 12, y0 + 320, lane.from, "mono muted"));
    if (i < lanes.length - 1) out.push(arrow(x + LW + 10, y0 + 24));
  });
  const y1 = y0 + LH + 26;
  out.push(t(0, y1, "Local can also anchor directly, skipping Web", "muted"));
  out.push(hline(272, 724, y1 - 4, "dash", "stroke:var(--btc);stroke-width:1.5"));
  out.push(`<path d="M724 ${y1 - 10} L732 ${y1 - 4} L724 ${y1 + 2} Z" style="fill:var(--btc)"/>`);
  out.push(t(W, y1, "Bitcoin", "muted", { anchor: "end" }));
  const y2 = y1 + 26;
  out.push(box(0, y2 - 12, 22, 14, "code", "stroke:var(--accent);stroke-width:1.5"));
  out.push(`<text x="32" y="${y2}" class="muted small">Outlined: what <tspan class="mono" data-api="OriginalsStudio.start">OriginalsStudio</tspan> wraps. Everything else is on <tspan class="mono">studio.sdk</tspan>, the full OriginalsSDK.</text>`);
  return svg(y2 + 8, "Where an Original lives: Local, Web, Bitcoin",
    "An Original moves one way: from Local to Web, and from either to Bitcoin. Local, in @originals/sdk: create, edit, deactivate, package, load, import and carry, with a MemoryStore or a FileStore. Web, in @originals/sdk: publish, hostedFiles and loadPublished, and for a shared host with several signers submit, sync and reconcile; an alias counts only if it points back. Bitcoin, in @originals/sdk/originals/bitcoin: anchor, prepareEntryInscription, submitEntryInscription, catchUp, readAnchored and transferHandoff; after anchoring a change counts only once it is inscribed on the sat. OriginalsStudio wraps create, edit, package and load.",
    out);
}

// ------------------------------------------------------------------ change

function change(): string {
  const out: string[] = [t(0, 14, "MAKING ONE CHANGE", "cap")];
  const y0 = 26, H = 110;
  out.push(box(0.5, y0 + 0.5, 210, H));
  out.push(t(12, y0 + 24, "prepareEdit", "mono b", { api: "OriginalsSDK#prepareEdit" }));
  out.push(t(12, y0 + 42, "→ Draft", "mono muted"));
  out.push(lines(12, y0 + 64, ["Unsigned. Never part of", "history, never packaged."], "muted"));
  out.push(arrow(216, y0 + H / 2));

  out.push(box(234.5, y0 + 0.5, 230, H));
  out.push(t(246, y0 + 24, "sign", "mono b", { api: "OriginalsSDK#sign" }));
  out.push(t(278, y0 + 24, "·", "muted"));
  out.push(t(290, y0 + 24, "cosign", "mono b", { api: "OriginalsSDK#cosign" }));
  out.push(t(246, y0 + 42, "→ SignedCandidate", "mono muted"));
  out.push(lines(246, y0 + 64, ["Each signer sees what it", "approves. A signer set signs", "one member at a time."], "muted"));
  out.push(arrow(470, y0 + H / 2));

  const fx = 488, fw = W - fx;
  out.push(box(fx + 0.5, y0 + 0.5, fw - 1, 51, "card", "stroke:var(--yes);stroke-width:1.5"));
  out.push(t(fx + 12, y0 + 22, "commit", "mono b", { api: "OriginalsSDK#commit" }));
  out.push(t(fx + 12, y0 + 40, "Local history moves, on an exact parent.", "muted"));
  out.push(box(fx + 0.5, y0 + 59.5, fw - 1, 51, "card", "stroke:var(--yes);stroke-width:1.5"));
  out.push(t(fx + 12, y0 + 81, "submit", "mono b", { api: "OriginalsSDK#submit" }));
  out.push(t(fx + 62, y0 + 81, "to a shared host", "muted small"));
  out.push(t(fx + 12, y0 + 99, "Committed only when the host accepts.", "muted"));

  const y1 = y0 + H + 28;
  out.push(`<text x="0" y="${y1}"><tspan class="mono" data-api="OriginalsSDK#edit">edit(did, { …, signer })</tspan> does all three in one call.</text>`);
  out.push(`<text x="0" y="${y1 + 20}" class="muted">If the Original moved meanwhile, it's a <tspan class="b" style="fill:var(--fg)">stale-parent</tspan> conflict. It is never rebased.</text>`);
  return svg(y1 + 28, "Making one change: prepare, sign, commit",
    "prepareEdit makes a Draft: unsigned, never history, never packaged. sign, or cosign for each member of a signer set, makes a SignedCandidate; each signer sees what it approves. commit moves local history on an exact parent; submit sends it to a shared host and commits only when the host accepts. edit with a signer does all three in one call. If the Original moved meanwhile, it is a stale-parent conflict, never rebased.",
    out);
}

// --------------------------------------------------------------- authority

function authority(): string {
  const out: string[] = [t(0, 14, "WHO MAY SIGN A CHANGE", "cap")];
  const rows: Array<[string, boolean, string]> = [
    ["Author", true, "One DID, fixed at genesis. Its keys rotate in the DID, never in the Original."],
    ["Signer set", true, "Several DIDs and a threshold, instead of one author."],
    ["Editor", true, "Only what its grant allows: the name, metadata, the resource, or a scope."],
    ["Parent's editors", true, "A child Original honours editor grants in its parent. The parent's author has no say."],
    ["Owner", false, "Holds the sat. Owns the Original, but can't sign changes."],
  ];
  rows.forEach(([who, can, what], i) => {
    const y = 26 + i * 40;
    out.push(box(0.5, y + 0.5, W - 1, 34));
    out.push(t(12, y + 22, who, "b"));
    out.push(t(132, y + 22, can ? "✓ can sign" : "✗ cannot sign", `small b ${can ? "yes" : "no"}`));
    out.push(t(236, y + 22, what, "muted"));
  });
  return svg(26 + rows.length * 40, "Who may sign a change",
    "The author, one DID fixed at genesis whose keys rotate in the DID only, can sign. A signer set, several DIDs and a threshold, can sign. An editor can sign only what its grant allows. A child Original honours editor grants in its parent, and the parent's author has no say. The owner, who holds the sat, cannot sign changes.",
    out);
}

// ------------------------------------------------------------------ report

function report(): string {
  const out: string[] = [t(0, 14, "WHAT A CHECK RETURNS · EACH PART REPORTED SEPARATELY", "cap")];
  const y = 40;
  out.push(t(0, y, "get", "mono", { api: "OriginalsSDK#get" }));
  out.push(t(26, y, "·", "muted"));
  out.push(t(38, y, "load", "mono", { api: "OriginalsSDK#load" }));
  out.push(t(70, y, "·", "muted"));
  out.push(t(82, y, "loadPublished", "mono", { api: "OriginalsSDK#loadPublished" }));
  out.push(t(178, y, "→ report", "muted"));
  out.push(t(300, y, "isVerified(report, reasons)", "mono", { api: "root:isVerified" }));
  out.push(t(488, y, "→ true or false", "muted"));
  const parts: Array<[string, string]> = [
    ["history", "Is the chain of entries valid?"],
    ["authorBinding", "Did the right keys sign?"],
    ["identityEvidence", "Signer DID histories, how fresh"],
    ["resources", "Bytes present, and matching"],
    ["ordering", "Claimed, or anchored on Bitcoin"],
    ["fork", "Divergent branches, if any"],
    ["ownership", "Who holds the sat (provisional)"],
    ["validAsOf", "The checkpoint it's valid as of"],
    ["current", "True only when anchored, from the sat"],
  ];
  const CW = (W - 20) / 3;
  parts.forEach(([name, what], i) => {
    const x = (i % 3) * (CW + 10), py = 56 + Math.floor(i / 3) * 54;
    out.push(box(x + 0.5, py + 0.5, CW - 1, 46, "card", name === "current" ? "stroke:var(--warn);stroke-width:1.5" : ""));
    out.push(t(x + 12, py + 20, name, "mono b", { report: name }));
    out.push(t(x + 12, py + 37, what, "muted"));
  });
  return svg(56 + 3 * 54, "What a check returns",
    "get, load and loadPublished return a report; isVerified(report, reasons) gives true or false. Each part is reported separately: history, authorBinding, identityEvidence, resources, ordering, fork, ownership, validAsOf, and current, which is true only for an anchored Original, read from its sat.",
    out);
}

/** File name → SVG text. */
export function diagrams(): Record<string, string> {
  return {
    "guided.svg": guided(),
    "layers.svg": layers(),
    "change.svg": change(),
    "authority.svg": authority(),
    "report.svg": report(),
  };
}

export const DIAGRAM_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "diagrams");

if (import.meta.main) {
  mkdirSync(DIAGRAM_DIR, { recursive: true });
  for (const [name, text] of Object.entries(diagrams())) writeFileSync(join(DIAGRAM_DIR, name), text);
  console.log(`wrote ${Object.keys(diagrams()).length} diagrams to ${DIAGRAM_DIR}`);
}
