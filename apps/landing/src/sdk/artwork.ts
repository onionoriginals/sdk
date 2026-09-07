/**
 * Deterministic generative artwork.
 *
 * The demo's asset is a real SVG file generated in the browser from a seed
 * (style + a regenerate nonce). The SVG's actual bytes are what the
 * SDK hashes, signs, publishes, and inscribes — so the provenance chain the
 * demo produces belongs to a concrete piece of art you can see, not to an
 * abstract JSON blob. Same seed → same bytes → same sha-256, which is the
 * point: provenance binds to content.
 */

/** cyrb128 — tiny string hash producing four 32-bit seeds. */
function cyrb128(str: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0];
}

/** sfc32 PRNG — deterministic, fast, good distribution. */
function sfc32(a: number, b: number, c: number, d: number): () => number {
  return () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

const PALETTES: Array<[string, string]> = [
  ['#a78bfa', '#4cc2ff'], // violet / sky
  ['#f7931a', '#a78bfa'], // amber / violet
  ['#4cc2ff', '#3fdd9d'], // sky / green
  ['#f7931a', '#4cc2ff'], // amber / sky
  ['#f472b6', '#a78bfa'], // pink / violet
  ['#3fdd9d', '#f7931a']  // green / amber
];

const S = 480; // viewBox size
const C = S / 2;

const f = (n: number) => +n.toFixed(1);

/** Orbital-constellation program: rings, arcs, satellites, connections. */
function orbits(rand: () => number, a: string, b: string, density: number): string {
  const parts: string[] = [];
  const ringCount = 4 + Math.floor(rand() * 3) + density;
  const satellites: Array<{ x: number; y: number; r: number; color: string }> = [];

  for (let i = 0; i < ringCount; i++) {
    const radius = f(52 + ((i + rand() * 0.7) / ringCount) * 160);
    const color = rand() < 0.5 ? a : b;
    const opacity = f(0.16 + rand() * 0.4);
    const width = f(0.8 + rand() * 1.6);
    const circumference = 2 * Math.PI * radius;
    if (rand() < 0.55) {
      // dashed arc ring
      const seg = f(circumference * (0.05 + rand() * 0.2));
      const gap = f(circumference * (0.02 + rand() * 0.12));
      const rot = f(rand() * 360);
      parts.push(
        `<circle cx="${C}" cy="${C}" r="${radius}" fill="none" stroke="${color}" stroke-width="${width}" stroke-opacity="${opacity}" stroke-dasharray="${seg} ${gap}" stroke-linecap="round" transform="rotate(${rot} ${C} ${C})"/>`
      );
    } else {
      parts.push(
        `<circle cx="${C}" cy="${C}" r="${radius}" fill="none" stroke="${color}" stroke-width="${width}" stroke-opacity="${f(opacity * 0.7)}"/>`
      );
    }
    // satellites on this ring
    const satCount = rand() < 0.7 ? 1 + Math.floor(rand() * 3) : 0;
    for (let s = 0; s < satCount; s++) {
      const angle = rand() * Math.PI * 2;
      satellites.push({
        x: f(C + Math.cos(angle) * radius),
        y: f(C + Math.sin(angle) * radius),
        r: f(1.6 + rand() * 2.6),
        color: rand() < 0.5 ? a : b
      });
    }
  }

  // constellation lines between nearby satellites
  for (let i = 0; i < satellites.length - 1; i++) {
    if (rand() < 0.4) {
      const p = satellites[i];
      const q = satellites[i + 1];
      parts.push(
        `<line x1="${p.x}" y1="${p.y}" x2="${q.x}" y2="${q.y}" stroke="${p.color}" stroke-opacity="0.14" stroke-width="0.8"/>`
      );
    }
  }
  for (const s of satellites) {
    parts.push(`<circle cx="${s.x}" cy="${s.y}" r="${f(s.r * 2.4)}" fill="${s.color}" opacity="0.12"/>`);
    parts.push(`<circle cx="${s.x}" cy="${s.y}" r="${s.r}" fill="${s.color}" opacity="0.9"/>`);
  }
  return parts.join('');
}

/** Radial-bars program (Music): a circular waveform. */
function radialBars(rand: () => number, a: string, b: string): string {
  const parts: string[] = [];
  const bars = 72;
  const inner = 78;
  for (let i = 0; i < bars; i++) {
    const angle = (i / bars) * Math.PI * 2 - Math.PI / 2;
    const len = 14 + rand() * 96 * (0.55 + 0.45 * Math.sin(i * (0.35 + rand() * 0.1)));
    const x1 = f(C + Math.cos(angle) * inner);
    const y1 = f(C + Math.sin(angle) * inner);
    const x2 = f(C + Math.cos(angle) * (inner + len));
    const y2 = f(C + Math.sin(angle) * (inner + len));
    const color = i % 2 === 0 ? a : b;
    parts.push(
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="2.6" stroke-linecap="round" stroke-opacity="${f(0.35 + rand() * 0.55)}"/>`
    );
  }
  parts.push(`<circle cx="${C}" cy="${C}" r="60" fill="none" stroke="${a}" stroke-opacity="0.5" stroke-width="1.2"/>`);
  return parts.join('');
}

/** Dot-matrix program (Dataset): a weighted grid. */
function dotGrid(rand: () => number, a: string, b: string): string {
  const parts: string[] = [];
  const n = 11;
  const pad = 70;
  const step = (S - pad * 2) / (n - 1);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const v = rand();
      if (v < 0.14) continue;
      const x = f(pad + i * step + (rand() - 0.5) * 5);
      const y = f(pad + j * step + (rand() - 0.5) * 5);
      const r = f(0.9 + v * v * 6.4);
      const color = v > 0.82 ? a : b;
      parts.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="${color}" opacity="${f(0.25 + v * 0.65)}"/>`);
      if (v > 0.93) {
        parts.push(`<circle cx="${x}" cy="${y}" r="${f(r * 2.6)}" fill="none" stroke="${color}" stroke-opacity="0.3" stroke-width="0.8"/>`);
      }
    }
  }
  return parts.join('');
}

/**
 * The generative styles, named for what they actually draw.
 *
 * These replace the old MEDIUM list (Artwork/Music/Writing/Photograph/Dataset),
 * which promised a content type the renderer never honoured: five labels mapped
 * onto three shapes, and "Photograph" drew vector orbits. A name the picture
 * cannot keep is worse than no name, so the control now says what you get.
 */
export const ART_STYLES = ['Orbits', 'Constellation', 'Radial Bars', 'Dot Grid'] as const;

export type ArtStyle = (typeof ART_STYLES)[number];

/** Title words. Deliberately plain: an evocative label the art can live up to. */
const NAME_FIRST = [
  'Amber', 'Violet', 'Cobalt', 'Halcyon', 'Distant', 'Quiet',
  'Pale', 'Deep', 'Slow', 'Bright', 'Late', 'Northern'
];
const NAME_SECOND = [
  'Orbit', 'Signal', 'Meridian', 'Transit', 'Aperture', 'Lattice',
  'Drift', 'Ascent', 'Perigee', 'Cadence', 'Vertex', 'Field'
];

/**
 * A title for a generated piece, from the same (style, nonce) pair that decides
 * the picture — so one Regenerate moves the name and the art together, and the
 * same seed always names the same artwork.
 */
export function generateName(style: string, nonce: number): string {
  const [s1, s2, s3, s4] = cyrb128(`name ${style} ${nonce}`);
  const rand = sfc32(s1, s2, s3, s4);
  const first = NAME_FIRST[Math.floor(rand() * NAME_FIRST.length)];
  const second = NAME_SECOND[Math.floor(rand() * NAME_SECOND.length)];
  const n = 1 + Math.floor(rand() * 999);
  return `${first} ${second} #${String(n).padStart(3, '0')}`;
}

export interface GeneratedArtwork {
  /** Complete standalone SVG document — the asset's actual bytes. */
  svg: string;
  /** data: URI for rendering the artwork in an <img>. */
  dataUri: string;
  palette: [string, string];
}

export function generateArtwork(
  title: string,
  style: string,
  nonce: number,
  opts: { transparent?: boolean } = {}
): GeneratedArtwork {
  // Seeded by STYLE and nonce, not the title: the picture is chosen by the
  // style you picked, so typing a name does not reshuffle the art under you.
  // The title still reaches the bytes below, via the SVG's <title> element.
  const seed = `${style} ${nonce}`;
  const [s1, s2, s3, s4] = cyrb128(seed);
  const rand = sfc32(s1, s2, s3, s4);
  const [a, b] = PALETTES[Math.floor(rand() * PALETTES.length)];

  let body: string;
  if (style === 'Radial Bars') body = radialBars(rand, a, b);
  else if (style === 'Dot Grid') body = dotGrid(rand, a, b);
  else body = orbits(rand, a, b, style === 'Constellation' ? 2 : 0);

  const coreR = f(16 + rand() * 14);
  const glowX = f(S * (0.3 + rand() * 0.4));
  const glowY = f(S * (0.3 + rand() * 0.4));

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" role="img">` +
    `<title>${escapeXml(title)} — ${escapeXml(style)}</title>` +
    `<defs>` +
    `<radialGradient id="g" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="${a}" stop-opacity="0.9"/><stop offset="60%" stop-color="${a}" stop-opacity="0.25"/><stop offset="100%" stop-color="${a}" stop-opacity="0"/></radialGradient>` +
    `<radialGradient id="glow" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="${b}" stop-opacity="0.16"/><stop offset="100%" stop-color="${b}" stop-opacity="0"/></radialGradient>` +
    `</defs>` +
    // transparent: strokes only, no backdrop — for ambient page decoration
    (opts.transparent
      ? ''
      : `<rect width="${S}" height="${S}" fill="#0b0d13"/>` +
        `<circle cx="${glowX}" cy="${glowY}" r="${S * 0.55}" fill="url(#glow)"/>`) +
    body +
    (style === 'Dot Grid'
      ? ''
      : `<circle cx="${C}" cy="${C}" r="${f(coreR * 2.6)}" fill="url(#g)"/><circle cx="${C}" cy="${C}" r="${coreR}" fill="${a}"/><circle cx="${C}" cy="${C}" r="${f(coreR * 0.45)}" fill="#0b0d13" opacity="0.55"/>`) +
    `</svg>`;

  return {
    svg,
    dataUri: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
    palette: [a, b]
  };
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
