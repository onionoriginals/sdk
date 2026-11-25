/**
 * Bitcoin previews (P9.30; owner decision, 18 November 2026; originals-spec
 * PR 64). For a version whose `mediaType` is an `image/` type, a writer
 * generates the preview an inscription carries as WebP, at most 8,192 bytes.
 * How it scales and encodes is its own choice; this one:
 *
 * - decodes PNG (APNG: its default image), JPEG, WebP (an animated WebP: its
 *   first frame), AVIF, GIF (its first frame) and SVG (rasterised, so a
 *   preview of an image is never active content, P9.7), chosen by the bytes'
 *   signature, not the declared type. An animated image gets a preview of one
 *   frame (P9.30 leaves it to the writer). Text in an SVG is not drawn: no
 *   fonts are loaded. Any other image (BMP, TIFF, HEIC, ICO, ...) is
 *   undecodable here. So that a small file cannot make it decode gigabytes,
 *   every raster, the first frame of an animation and every image an SVG
 *   embeds included, is sized from its header first: one of more than 50
 *   million pixels, or one whose header gives no size, is not decoded and
 *   gets no preview.
 * - scales the longest edge down through 512, 384, 256, 192, 128, 96, 64, 48
 *   and 32 pixels (never up), with an alpha-weighted box filter, and encodes
 *   at quality 80 down to 40 at each size, largest first, then at 30 down to
 *   5, until the WebP fits 8,192 bytes.
 * - encodes with one WASM build of libwebp, the scalar (non-SIMD) one, in
 *   browsers and in Node alike, so the same bytes give the same preview
 *   everywhere.
 *
 * Nothing heavy loads until a preview is made: every codec is a dynamic
 * import, and its WASM is fetched by the codec next to itself in a browser
 * (bundlers emit it as an asset) or read from `node_modules` in Node and Bun.
 * The SVG rasteriser's WASM has no such default in a browser: give it with
 * `configurePreviewCodecs({ resvgWasm })`, or an SVG gets no preview there
 * and the author is told.
 *
 * PROVISIONAL: the sizes, qualities and libwebp settings are this writer's;
 * the spec fixes only the media type and the limit (P9.30, P14.13).
 */
import { OriginalsError } from "@originals/vh";
import { ORIGINALS_LIMITS, IMAGE_PREVIEW_MEDIA_TYPE, isImageMediaType, resourceDigest, type PreviewDescriptor } from "@originals/vh/originals";

/** The largest preview, in bytes (P9.30, P14.13). */
export const PREVIEW_MAX_BYTES: number = ORIGINALS_LIMITS.previewBytes;

/** Longest edges tried, largest first (PROVISIONAL). */
export const PREVIEW_EDGES: readonly number[] = Object.freeze([512, 384, 256, 192, 128, 96, 64, 48, 32]);
/** WebP qualities tried at each edge, highest first (PROVISIONAL). */
export const PREVIEW_QUALITIES: readonly number[] = Object.freeze([80, 70, 60, 50, 40, 30, 20, 10, 5]);
/** Every edge is tried down to this quality before any lower one (PROVISIONAL). */
export const PREVIEW_FAIR_QUALITY = 40;

/** A decoded image larger than this many pixels is not decoded (it would need gigabytes). */
const MAX_PIXELS = 50_000_000;

export type ImageFormat = "png" | "jpeg" | "webp" | "avif" | "gif" | "svg";

/** A preview made for a version (P9.30): its bytes, its descriptor for the entry, and how it was made. */
export interface GeneratedPreview {
  bytes: Uint8Array;
  descriptor: PreviewDescriptor;
  width: number;
  height: number;
  quality: number;
  /** The decoded source: its format, its size, and whether only its first frame was used. */
  source: { format: ImageFormat; width: number; height: number; firstFrameOnly: boolean };
}

/**
 * Why no preview was made for an image version: the writer tells the author
 * and names no preview (P9.30). `undecodable`: its bytes are no image this
 * writer decodes. `too-large`: no WebP of it fits 8,192 bytes (or none that
 * differs from the parent's preview).
 */
export interface PreviewFailure {
  reason: "undecodable" | "too-large";
  message: string;
}

/**
 * What an entry prepared for Bitcoin names as its preview, and what its
 * inscription's body will be (P9.30, P9.17), told to the author with the
 * commit: `generated` for an image, `supplied` by the author for any other
 * type, `kept` from the parent (same version), or `none`, with the reason and
 * a message to show. `body` is what the inscription carries by default:
 * `preview`, `full` (the author chose the full version; pass `body: "full"`
 * again when inscribing), or `none` (no body unless the full version is
 * chosen when inscribing).
 */
export interface PreviewReport {
  status: "generated" | "supplied" | "kept" | "none";
  body: "preview" | "full" | "none";
  /** Why no preview is named. */
  reason?: "full-version-chosen" | "not-an-image" | "undecodable" | "too-large" | "version-bytes-missing" | "parent-named-none";
  message: string;
  /** The preview named, when one is. */
  descriptor?: PreviewDescriptor;
  /** How a generated preview was made. */
  generated?: Pick<GeneratedPreview, "width" | "height" | "quality" | "source">;
}

export type PreviewResult = { status: "generated"; preview: GeneratedPreview } | { status: "failed"; failure: PreviewFailure };

export interface GeneratePreviewOptions {
  /**
   * Digests a generated preview must not have: the parent's preview, so an
   * entry that changes the version never carries it unchanged (P9.30). The
   * search goes on to another size or quality.
   */
  avoid?: Iterable<string>;
  /** A smaller limit than 8,192 bytes, if the writer wants one (never larger: P9.30, P14.13). */
  maxBytes?: number;
}

/** Where the codecs find their WASM when the default does not work. */
export interface PreviewCodecConfig {
  /**
   * The SVG rasteriser's WASM (`@resvg/resvg-wasm/index_bg.wasm`): a URL, a
   * Response, the bytes or a compiled module. Needed in a browser for SVG
   * previews; Node and Bun read it from `node_modules`.
   */
  resvgWasm?: string | URL | Response | ArrayBuffer | ArrayBufferView | WebAssembly.Module | Promise<Response>;
  /**
   * The waits, in milliseconds, before each retry of a codec step when WASM memory runs out
   * (`PREVIEW_CODEC_RETRY_DELAYS_MS` by default). The runtime frees the memory of unreachable
   * instances some time after a collection, not at once, so each retry waits. They are used only
   * when memory runs out, and change only how long that takes, never the preview.
   */
  retryDelaysMs?: readonly number[];
}

let config: PreviewCodecConfig = {};

/** Configure where the preview codecs find their WASM (see `PreviewCodecConfig`). */
export function configurePreviewCodecs(next: PreviewCodecConfig): void {
  config = { ...config, ...next };
}

interface Rgba {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}

const fail = (reason: PreviewFailure["reason"], message: string): PreviewResult => ({ status: "failed", failure: { reason, message } });

/**
 * Generate the WebP preview of an `image/` version (P9.30). Deterministic: the
 * same bytes and `avoid` give the same preview. Never throws for bad image
 * bytes: an image it cannot decode, or cannot fit in 8,192 bytes, is a
 * `failed` result the caller tells the author about. Throws `invalid-evidence`
 * for a `mediaType` that is not an `image/` type: the author supplies the
 * preview of any other version, or none.
 *
 * There is no time budget: no step reads a clock, so a slow or loaded machine
 * gives the same result as a fast one, only later. What a loaded process can
 * run out of is WASM memory (an instance, or the growth of one). That is never
 * the image's fault, so it is never a `failed` result: the codec instance is
 * discarded (its heap may be left mid-call), memory is reclaimed, and the step
 * is retried with a fresh instance after the waits in `PREVIEW_CODEC_RETRY_DELAYS_MS`
 * (`PREVIEW_CODEC_ATTEMPTS` tries in all; `configurePreviewCodecs` can change them). If
 * memory is still short, this throws `limit-exceeded`
 * `PREVIEW_RUNTIME_EXHAUSTED`, so no caller silently names no preview. A WASM
 * trap is treated the same way: retried on a fresh instance, and taken as the
 * image's only when it recurs identically there; otherwise this throws
 * `PREVIEW_RUNTIME_FAULT`. A `failed` result is only ever the image's.
 */
export async function generateImagePreview(bytes: Uint8Array, mediaType: string, options: GeneratePreviewOptions = {}): Promise<PreviewResult> {
  if (!isImageMediaType(mediaType)) {
    throw new OriginalsError("invalid-evidence", "PREVIEW_NOT_AN_IMAGE", `${mediaType} is not an image/ type: the author supplies its preview, or none (P9.30)`);
  }
  const format = sniff(bytes, mediaType);
  if (!format) return fail("undecodable", `the version's bytes are no image this writer decodes (PNG, JPEG, WebP, AVIF, GIF or SVG); no preview is named (P9.30)`);
  let decoded: { image: Rgba; firstFrameOnly: boolean };
  try {
    // Every raster is sized from its header before it is decoded, so a few kilobytes that would decode
    // to gigabytes are refused first; one that cannot be sized is not decoded at all. An SVG is
    // rasterised at most 512 pixels on its longest edge, and its embedded images are sized the same
    // way (`rasteriseSvg`).
    if (format !== "svg") checkPixels(format.toUpperCase(), dimensions(bytes, format));
    decoded = await decode(bytes, format);
  } catch (error) {
    if (error instanceof OriginalsError && (error.code === "PREVIEW_RUNTIME_EXHAUSTED" || error.code === "PREVIEW_RUNTIME_FAULT")) throw error;
    if (exhausted(error)) throw runtimeExhausted(error);
    if (error instanceof TooLarge) return fail("undecodable", `${error.message}; no preview is named (P9.30)`);
    if (error instanceof OriginalsError && error.code === "PREVIEW_CODEC_UNAVAILABLE") return fail("undecodable", error.message);
    return fail("undecodable", `the ${format.toUpperCase()} could not be decoded (${error instanceof Error ? error.message : String(error)}); no preview is named (P9.30)`);
  }
  const { image } = decoded;
  if (image.width < 1 || image.height < 1 || image.data.length !== image.width * image.height * 4) {
    return fail("undecodable", `the ${format.toUpperCase()} decoded to no pixels; no preview is named (P9.30)`);
  }
  if (image.width * image.height > MAX_PIXELS) {
    return fail("undecodable", `the ${format.toUpperCase()} decoded to ${image.width}×${image.height} pixels, too large to decode for a preview; no preview is named (P9.30)`);
  }
  const avoid = new Set(options.avoid ?? []);
  const limit = Math.min(PREVIEW_MAX_BYTES, options.maxBytes ?? PREVIEW_MAX_BYTES);
  if (!(limit >= 1)) throw new OriginalsError("invalid-evidence", "INPUT_INVALID", "maxBytes is at least 1 (P9.30)");
  const longest = Math.max(image.width, image.height);
  // Never scale up: an image smaller than an edge is tried at its own size first.
  const edges = [...new Set([Math.min(longest, PREVIEW_EDGES[0]), ...PREVIEW_EDGES.filter((e) => e < longest)])];
  const lowest = PREVIEW_QUALITIES[PREVIEW_QUALITIES.length - 1];
  const scaledAt = new Map<number, Rgba>();
  const encoded = new Map<string, Uint8Array>();
  const encode = async (edge: number, quality: number) => {
    const key = `${edge}:${quality}`;
    let out = encoded.get(key);
    if (!out) {
      let scaled = scaledAt.get(edge);
      if (!scaled) scaledAt.set(edge, (scaled = edge >= longest ? image : resize(image, edge)));
      const input = scaled;
      encoded.set(key, (out = await withCodec("webp-enc", loadWebpEncoder, (encoder) => encoder(input, quality))));
    }
    return out;
  };
  // Two passes: every size at a fair quality first, so a busy image gets a smaller sharp preview
  // before a large blurry one; then the low qualities.
  for (const tier of [PREVIEW_QUALITIES.filter((q) => q >= PREVIEW_FAIR_QUALITY), PREVIEW_QUALITIES.filter((q) => q < PREVIEW_FAIR_QUALITY)]) {
    for (const edge of edges) {
      // If the tier's lowest quality does not fit at this size, none of it does: go smaller.
      if ((await encode(edge, tier[tier.length - 1])).length > limit) continue;
      for (const quality of tier) {
        const out = await encode(edge, quality);
        if (out.length < 1 || out.length > limit) continue;
        const digest = resourceDigest(out);
        if (avoid.has(digest)) continue;
        const scaled = scaledAt.get(edge)!;
        return {
          status: "generated",
          preview: {
            bytes: out,
            descriptor: { mediaType: IMAGE_PREVIEW_MEDIA_TYPE, size: out.length, digest },
            width: scaled.width,
            height: scaled.height,
            quality,
            source: { format, width: image.width, height: image.height, firstFrameOnly: decoded.firstFrameOnly },
          },
        };
      }
    }
  }
  return fail("too-large", `no WebP of this image fits ${limit} bytes${avoid.size > 0 ? " and differs from the parent's preview" : ""}, down to ${PREVIEW_EDGES[PREVIEW_EDGES.length - 1]} pixels at quality ${lowest}; no preview is named (P9.30)`);
}

// ------------------------------------------------------------------ formats

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((x, i) => b[at + i] === x);
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

/** The format of an image's bytes, by signature; SVG by its declared type, which has none. */
export function sniff(bytes: Uint8Array, mediaType: string): ImageFormat | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "webp";
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")) return "gif";
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === "ftyp" && ["avif", "avis"].includes(ascii(bytes, 8, 12))) return "avif";
  if (mediaType.toLowerCase().split("/")[1] === "svg+xml") return "svg";
  return undefined;
}

const u16le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u24le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
const u32be = (b: Uint8Array, at: number) => ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];

/** A raster that is too large to decode, or cannot be sized before decoding. */
class TooLarge extends Error {}

/** The ISO BMFF boxes directly inside `from`..`to`: each one's type, where its body starts and where it ends. */
function childBoxes(b: Uint8Array, from: number, to: number): Array<{ type: string; body: number; end: number }> {
  const out: Array<{ type: string; body: number; end: number }> = [];
  for (let at = from; at + 8 <= to; ) {
    let size = u32be(b, at);
    let body = at + 8;
    if (size === 1) {
      if (at + 16 > to) break;
      // A 64-bit size; the high half must be zero for anything this reader holds.
      if (u32be(b, at + 8) !== 0) break;
      size = u32be(b, at + 12);
      body = at + 16;
    } else if (size === 0) size = to - at;
    if (size < body - at || at + size > to) break;
    out.push({ type: ascii(b, at + 4, at + 8), body, end: at + size });
    at += size;
  }
  return out;
}

/** Refuse an image of more than MAX_PIXELS pixels, or of no size its header gives, before decoding it. */
function checkPixels(what: string, dims: { width: number; height: number } | undefined): void {
  if (!dims) throw new TooLarge(`the ${what} cannot be sized from its header, so it is not decoded`);
  if (dims.width * dims.height > MAX_PIXELS) throw new TooLarge(`the ${what} is ${dims.width}×${dims.height} pixels, too large to decode for a preview`);
}

/**
 * An image's size from its header, so a huge one is refused before decoding;
 * undefined when the header does not give it. For an AVIF, the largest of its
 * `ispe` properties, which every image item carries.
 */
function dimensions(b: Uint8Array, format: ImageFormat): { width: number; height: number } | undefined {
  if (format === "png" && b.length >= 24 && ascii(b, 12, 16) === "IHDR") return { width: u32be(b, 16), height: u32be(b, 20) };
  if (format === "gif" && b.length >= 10) return { width: u16le(b, 6), height: u16le(b, 8) };
  if (format === "avif") {
    // The ispe properties are read where ISO/IEC 23008-12 puts them, meta > iprp > ipco, never
    // by scanning: the coded image data can hold the bytes "ispe" anywhere.
    let largest: { width: number; height: number } | undefined;
    const meta = childBoxes(b, 0, b.length).find((x) => x.type === "meta");
    // meta is a FullBox: version and flags before its children.
    const iprp = meta && childBoxes(b, meta.body + 4, meta.end).find((x) => x.type === "iprp");
    const ipco = iprp && childBoxes(b, iprp.body, iprp.end).find((x) => x.type === "ipco");
    for (const ispe of ipco ? childBoxes(b, ipco.body, ipco.end).filter((x) => x.type === "ispe") : []) {
      // An ispe box: version and flags, then width and height.
      if (ispe.body + 12 > ispe.end) continue;
      const dims = { width: u32be(b, ispe.body + 4), height: u32be(b, ispe.body + 8) };
      if (!largest || dims.width * dims.height > largest.width * largest.height) largest = dims;
    }
    return largest;
  }
  if (format === "webp" && b.length >= 30) {
    const kind = ascii(b, 12, 16);
    if (kind === "VP8X") return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
    if (kind === "VP8 ") return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
    if (kind === "VP8L") {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
  }
  if (format === "jpeg") {
    for (let i = 2; i + 9 < b.length; ) {
      if (b[i] !== 0xff) return undefined;
      // Any marker may be preceded by fill bytes (0xFF) (ITU-T T.81 B.1.1.2).
      while (b[i + 1] === 0xff && i + 10 < b.length) i++;
      const marker = b[i + 1];
      // TEM, RSTn, SOI and EOI stand alone, with no length.
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        i += 2;
        continue;
      }
      // SOF0-SOF15, except DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
      }
      // A scan before any frame header: no size to read.
      if (marker === 0xda) return undefined;
      i += 2 + ((b[i + 2] << 8) | b[i + 3]);
    }
  }
  return undefined;
}

/**
 * The first frame of an animated WebP as a still WebP (P9.30 lets the writer
 * preview one frame): the first ANMF chunk's frame data, under a VP8X header
 * when it has alpha. Undefined when the file is not an animated WebP.
 */
export function firstWebpFrame(b: Uint8Array): Uint8Array | undefined {
  if (b.length < 30 || ascii(b, 12, 16) !== "VP8X" || (b[20] & 0x02) === 0) return undefined;
  for (let at = 12; at + 8 <= b.length; ) {
    const id = ascii(b, at, at + 4);
    const size = (b[at + 4] | (b[at + 5] << 8) | (b[at + 6] << 16) | (b[at + 7] << 24)) >>> 0;
    if (id === "ANMF" && at + 8 + size <= b.length && size >= 16) {
      const frame = b.subarray(at + 8, at + 8 + size);
      const width = u24le(frame, 6) + 1;
      const height = u24le(frame, 9) + 1;
      const data = frame.subarray(16);
      const alpha = data.length >= 4 && ascii(data, 0, 4) === "ALPH";
      const vp8x = new Uint8Array(18);
      vp8x.set([0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0, alpha ? 0x10 : 0, 0, 0, 0]);
      vp8x.set([(width - 1) & 0xff, ((width - 1) >> 8) & 0xff, ((width - 1) >> 16) & 0xff, (height - 1) & 0xff, ((height - 1) >> 8) & 0xff, ((height - 1) >> 16) & 0xff], 12);
      const body = new Uint8Array(4 + vp8x.length + data.length);
      body.set([0x57, 0x45, 0x42, 0x50]);
      body.set(vp8x, 4);
      body.set(data, 4 + vp8x.length);
      const out = new Uint8Array(8 + body.length);
      out.set([0x52, 0x49, 0x46, 0x46, body.length & 0xff, (body.length >> 8) & 0xff, (body.length >> 16) & 0xff, (body.length >>> 24) & 0xff]);
      out.set(body, 8);
      return out;
    }
    at += 8 + size + (size & 1);
  }
  return undefined;
}

// ------------------------------------------------------------------ codecs

/** Whether this is Node or Bun, where the codecs' WASM is read from `node_modules`. */
function isNode(): boolean {
  const p = (globalThis as { process?: { versions?: { node?: string } } }).process;
  return typeof p?.versions?.node === "string";
}

/** A codec's compiled WASM in Node or Bun, read from the installed package; undefined in a browser. */
async function nodeWasm(specifier: string): Promise<WebAssembly.Module | undefined> {
  if (!isNode()) return undefined;
  // Not statically visible to bundlers, so no browser build pulls in a Node built-in.
  const fsName = "node:fs/promises";
  const urlName = "node:url";
  const { readFile } = (await import(/* @vite-ignore */ fsName)) as typeof import("node:fs/promises");
  const { fileURLToPath } = (await import(/* @vite-ignore */ urlName)) as typeof import("node:url");
  const meta = import.meta as ImportMeta & { resolve?: (s: string) => string };
  if (typeof meta.resolve !== "function") throw new OriginalsError("unsupported-profile", "PREVIEW_CODEC_UNAVAILABLE", "this runtime cannot locate the preview codecs (import.meta.resolve); no preview is named (P9.30)");
  return WebAssembly.compile(await readFile(fileURLToPath(meta.resolve(specifier))));
}

type EmscriptenFactory = (options: Record<string, unknown>) => Promise<unknown>;

/** Instantiate an Emscripten codec: with its WASM read here in Node, or fetched by the codec itself in a browser. */
async function emscripten<T>(factory: EmscriptenFactory, wasm: string): Promise<T> {
  const module = await nodeWasm(wasm);
  const instantiateWasm = module
    ? (imports: Record<string, Record<string, unknown>>, done: (instance: WebAssembly.Instance) => void) => {
        const instance = new WebAssembly.Instance(module, imports as never);
        done(instance);
        return instance.exports;
      }
    : undefined;
  return (await factory({ noInitialRun: true, ...(instantiateWasm ? { instantiateWasm } : {}) })) as T;
}

/** The scalar libwebp encoder, the same build everywhere (deterministic output). */
async function loadWebpEncoder(): Promise<(image: Rgba, quality: number) => Uint8Array> {
  const [{ default: factory }, { defaultOptions }] = await Promise.all([
    import("@jsquash/webp/codec/enc/webp_enc.js"),
    import("@jsquash/webp/meta.js"),
  ]);
  const module = await emscripten<{ encode(data: ArrayBuffer | ArrayBufferView, width: number, height: number, options: Record<string, number>): Uint8Array | null }>(
    factory, "@jsquash/webp/codec/enc/webp_enc.wasm",
  );
  return (image: Rgba, quality: number) => {
    const out = module.encode(image.data, image.width, image.height, { ...(defaultOptions as unknown as Record<string, number>), quality, method: 4, exact: 0 });
    if (!out) throw new Error("WebP encoding failed");
    return new Uint8Array(out);
  };
}

/** Each codec instance, loaded once and kept while it works. */
const codecs = new Map<string, Promise<unknown>>();
function once<T>(key: string, load: () => Promise<T>): Promise<T> {
  let p = codecs.get(key) as Promise<T> | undefined;
  if (!p) {
    p = load();
    codecs.set(key, p);
    p.catch(() => { if (codecs.get(key) === p) codecs.delete(key); });
  }
  return p;
}

/**
 * The default waits before each retry of a codec step on a fresh instance: 250 ms, 1 s, then 4 s,
 * about 5 s in all. Generous for a loaded machine (a runtime that had run out of WASM memory was
 * seen to free it about half a second after a collection), and never spent when a step succeeds.
 */
export const PREVIEW_CODEC_RETRY_DELAYS_MS: readonly number[] = Object.freeze([250, 1000, 4000]);
/** How many times a codec step is tried by default, each retry on a fresh instance. */
export const PREVIEW_CODEC_ATTEMPTS = PREVIEW_CODEC_RETRY_DELAYS_MS.length + 1;

const messageOf = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

/**
 * Whether an error is the WASM runtime running out of memory: no memory for a new
 * instance, or a failed growth of one (an Emscripten OOM abort). A property of the
 * process at that moment, never of the image.
 */
export function exhausted(error: unknown): boolean {
  return /out of memory|cannot allocate|allocation failed|Aborted\(OOM\)|enlarge memory|Memory\.grow|WebAssembly\.Memory/i.test(messageOf(error));
}

const retryDelays = () => config.retryDelaysMs ?? PREVIEW_CODEC_RETRY_DELAYS_MS;

function runtimeExhausted(error: unknown): OriginalsError {
  return new OriginalsError("limit-exceeded", "PREVIEW_RUNTIME_EXHAUSTED", `the WASM runtime ran out of memory making the preview (${error instanceof Error ? error.message : String(error)}), after ${retryDelays().length + 1} attempts with fresh codec instances; this is not a property of the image: try again with more memory free (P9.30)`);
}

function runtimeFault(errors: unknown[]): OriginalsError {
  return new OriginalsError("unavailable-bytes", "PREVIEW_RUNTIME_FAULT", `the preview codec failed differently on ${errors.length} fresh instances (${errors.map(messageOf).join("; ")}), so the failure is not taken as the image's; no preview is chosen silently: try again (P9.30)`);
}

/** Collect garbage where the runtime allows it, then wait `ms`, so unreachable WASM instances are freed before a retry. */
async function reclaim(ms: number): Promise<void> {
  const g = globalThis as { Bun?: { gc?: (sync: boolean) => void }; gc?: () => void };
  if (typeof g.Bun?.gc === "function") g.Bun.gc(true);
  else if (typeof g.gc === "function") g.gc();
  await new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

/** Test seam: what a codec step runs before using its instance (none by default). */
let beforeCodecStep: ((key: string) => void) | undefined;
/** @internal For tests only: make codec steps fail, to exercise the retries. */
export function setPreviewCodecFault(fault: ((key: string) => void) | undefined): void {
  beforeCodecStep = fault;
}

/**
 * Run `use` on the codec `key`, so that the same input gives the same result whatever ran before.
 *
 * - An instance that threw, for any reason, is discarded: it may be left mid-call (an Emscripten
 *   abort or a WASM trap leaves it unusable), so what one image did never reaches the next.
 * - WASM memory running out is retried on a fresh instance after each wait in
 *   `PREVIEW_CODEC_RETRY_DELAYS_MS`; still short after the last, it throws
 *   `PREVIEW_RUNTIME_EXHAUSTED`.
 * - Any other error, a trap included, is the image's only when it recurs identically on a fresh
 *   instance: it is then thrown as it is (the caller reports the image undecodable). Errors that
 *   differ on every fresh instance throw `PREVIEW_RUNTIME_FAULT`: no `failed` result is reported
 *   for a fault that was never shown to be the image's.
 */
async function withCodec<M, T>(key: string, load: () => Promise<M>, use: (codec: M) => T | Promise<T>): Promise<T> {
  const delays = retryDelays();
  const errors: unknown[] = [];
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    const fresh = !codecs.has(key);
    try {
      const codec = await once(key, load);
      beforeCodecStep?.(key);
      return await use(codec);
    } catch (error) {
      codecs.delete(key);
      const previous = errors[errors.length - 1];
      errors.push(error);
      if (!exhausted(error) && fresh && previous !== undefined && !exhausted(previous) && messageOf(previous) === messageOf(error)) throw error;
      if (attempt < delays.length) await reclaim(delays[attempt]);
    }
  }
  const last = errors[errors.length - 1];
  if (exhausted(last)) throw runtimeExhausted(last);
  throw runtimeFault(errors);
}

type DecodeModule = { decode(data: ArrayBuffer | ArrayBufferView, ...rest: unknown[]): Rgba | null };

async function decode(bytes: Uint8Array, format: ImageFormat): Promise<{ image: Rgba; firstFrameOnly: boolean }> {
  const copy = new Uint8Array(bytes);
  if (format === "png") {
    // wasm-bindgen keeps one PNG instance per process, so a retry here runs on that same instance;
    // the Emscripten decoders (JPEG, WebP, AVIF) and the encoder get a fresh one each time.
    const load = async () => {
      const m = await import("@jsquash/png/decode.js");
      await m.init((await nodeWasm("@jsquash/png/codec/pkg/squoosh_png_bg.wasm")));
      return m;
    };
    return { image: await withCodec("png", load, (png) => png.decode(copy.buffer)), firstFrameOnly: false };
  }
  if (format === "jpeg") {
    const load = async () => emscripten<DecodeModule>((await import("@jsquash/jpeg/codec/dec/mozjpeg_dec.js")).default, "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm");
    // Honour the EXIF orientation, as a viewer shows it.
    return { image: await withCodec("jpeg", load, (jpeg) => required(jpeg.decode(new Uint8Array(copy), true))), firstFrameOnly: false };
  }
  if (format === "webp") {
    const load = async () => emscripten<DecodeModule>((await import("@jsquash/webp/codec/dec/webp_dec.js")).default, "@jsquash/webp/codec/dec/webp_dec.wasm");
    const frame = firstWebpFrame(copy);
    // The first frame is sized on its own: the canvas does not bound it.
    if (frame) checkPixels("WebP frame", dimensions(frame, "webp"));
    const input = frame ?? copy;
    return { image: await withCodec("webp", load, (webp) => required(webp.decode(new Uint8Array(input)))), firstFrameOnly: frame !== undefined };
  }
  if (format === "avif") {
    const load = async () => emscripten<DecodeModule>((await import("@jsquash/avif/codec/dec/avif_dec.js")).default, "@jsquash/avif/codec/dec/avif_dec.wasm");
    return { image: await withCodec("avif", load, (avif) => required(avif.decode(new Uint8Array(copy), 8))), firstFrameOnly: false };
  }
  if (format === "gif") return decodeGif(copy);
  return rasteriseSvg(copy);
}

function required(image: Rgba | null): Rgba {
  if (!image) throw new Error("the decoder returned no image");
  return image;
}

async function decodeGif(bytes: Uint8Array): Promise<{ image: Rgba; firstFrameOnly: boolean }> {
  const mod = (await import("omggif")) as unknown as { GifReader?: GifReaderClass; default?: { GifReader: GifReaderClass } };
  const GifReader = mod.GifReader ?? mod.default!.GifReader;
  const reader = new GifReader(bytes);
  // The first frame is decoded at its own size, which the screen does not bound.
  const first = reader.frameInfo(0);
  checkPixels("GIF frame", { width: first.width, height: first.height });
  checkPixels("GIF", { width: reader.width, height: reader.height });
  const data = new Uint8ClampedArray(reader.width * reader.height * 4);
  reader.decodeAndBlitFrameRGBA(0, data);
  return { image: { data, width: reader.width, height: reader.height }, firstFrameOnly: reader.numFrames() > 1 };
}

interface GifReaderClass {
  new (bytes: Uint8Array): {
    width: number;
    height: number;
    numFrames(): number;
    frameInfo(frame: number): { width: number; height: number };
    decodeAndBlitFrameRGBA(frame: number, pixels: Uint8ClampedArray): void;
  };
}

let resvgReady: Promise<typeof import("@resvg/resvg-wasm")> | undefined;

async function rasteriseSvg(bytes: Uint8Array): Promise<{ image: Rgba; firstFrameOnly: boolean }> {
  resvgReady ??= (async () => {
    const resvg = await import("@resvg/resvg-wasm");
    const wasm = config.resvgWasm ?? (await nodeWasm("@resvg/resvg-wasm/index_bg.wasm"));
    if (wasm === undefined) {
      throw new OriginalsError("unsupported-profile", "PREVIEW_CODEC_UNAVAILABLE", "the SVG rasteriser is not configured in this browser (configurePreviewCodecs({ resvgWasm })); no preview is named (P9.30)");
    }
    await resvg.initWasm(wasm);
    return resvg;
  })();
  resvgReady.catch(() => { resvgReady = undefined; });
  const { Resvg } = await resvgReady;
  const probe = new Resvg(bytes, { font: { loadSystemFonts: false } });
  let landscape: boolean;
  try {
    landscape = probe.width >= probe.height;
    // resvg decodes an embedded raster at its own size, whatever size it is drawn at: size each one
    // from its header first, as a raster version is, nested SVGs included (P9.30 leaves the rest to us).
    const embedded = embeddedPixels(Resvg, probe.toString(), 0);
    if (embedded > MAX_PIXELS) throw new TooLarge(`the SVG embeds images of ${embedded} pixels, too large to decode for a preview`);
  } finally {
    probe.free();
  }
  const edge = PREVIEW_EDGES[0];
  const svg = new Resvg(bytes, { font: { loadSystemFonts: false }, fitTo: landscape ? { mode: "width", value: edge } : { mode: "height", value: edge } });
  try {
    const rendered = svg.render();
    const image = { data: new Uint8ClampedArray(rendered.pixels), width: rendered.width, height: rendered.height };
    rendered.free();
    return { image, firstFrameOnly: false };
  } finally {
    svg.free();
  }
}

/** How deep SVG images may nest in an SVG before it is refused. */
const MAX_SVG_NESTING = 3;

/**
 * The pixels of every raster an SVG embeds, by their headers, from resvg's
 * own normalised form of it, where every embedded image, entity references
 * resolved, is a `data:` URL in base64. A nested SVG is counted the same way.
 * Throws TooLarge for one that cannot be sized, or nesting too deep.
 */
function embeddedPixels(Resvg: typeof import("@resvg/resvg-wasm").Resvg, normalised: string, depth: number): number {
  let total = 0;
  for (const m of normalised.matchAll(/data:([^;"\s]*);base64,\s*([A-Za-z0-9+/=]*)/g)) {
    const data = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
    const format = sniff(data, m[1]);
    if (format === "svg") {
      if (depth >= MAX_SVG_NESTING) throw new TooLarge("the SVG nests SVG images too deeply");
      const nested = new Resvg(data, { font: { loadSystemFonts: false } });
      try {
        total += embeddedPixels(Resvg, nested.toString(), depth + 1);
      } finally {
        nested.free();
      }
      continue;
    }
    const dims = format ? dimensions(data, format) : undefined;
    if (!dims) throw new TooLarge("an image the SVG embeds cannot be sized from its header, so the SVG is not rasterised");
    total += dims.width * dims.height;
  }
  return total;
}

// ------------------------------------------------------------------ scaling

/**
 * Scale an image so its longest edge is `edge` pixels, with an area-weighted
 * box filter whose colour is weighted by alpha, so transparent pixels do not
 * darken the edges. Plain arithmetic, so the same input gives the same output
 * in every engine.
 */
export function resize(image: Rgba, edge: number): Rgba {
  const { width: w, height: h, data } = image;
  const scale = edge / Math.max(w, h);
  const W = Math.max(1, Math.round(w * scale));
  const H = Math.max(1, Math.round(h * scale));
  const out = new Uint8ClampedArray(W * H * 4);
  const sx = w / W;
  const sy = h / H;
  for (let Y = 0; Y < H; Y++) {
    const y0 = Y * sy;
    const y1 = y0 + sy;
    for (let X = 0; X < W; X++) {
      const x0 = X * sx;
      const x1 = x0 + sx;
      let r = 0, g = 0, b = 0, a = 0, area = 0;
      for (let y = Math.floor(y0); y < Math.min(h, Math.ceil(y1)); y++) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0);
        for (let x = Math.floor(x0); x < Math.min(w, Math.ceil(x1)); x++) {
          const weight = wy * (Math.min(x + 1, x1) - Math.max(x, x0));
          const i = (y * w + x) * 4;
          const alpha = data[i + 3] * weight;
          r += data[i] * alpha;
          g += data[i + 1] * alpha;
          b += data[i + 2] * alpha;
          a += alpha;
          area += weight;
        }
      }
      const o = (Y * W + X) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round(a / area);
    }
  }
  return { data: out, width: W, height: H };
}
