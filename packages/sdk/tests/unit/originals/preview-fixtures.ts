/**
 * Image fixtures for the preview tests, made at test time so the repository
 * carries no binary images: PNG through fflate, JPEG and AVIF through the
 * jsquash encoders (their WASM read from node_modules, since the test preload
 * mocks fetch), GIF through omggif, animated WebP assembled from two still
 * WebP frames, and SVG as text.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { zlibSync } from "fflate";
import { GifWriter } from "omggif";
import { crc32 } from "../../../src/originals/zip.js";

export interface Pixels { data: Uint8ClampedArray; width: number; height: number }

/** A deterministic busy image: gradients with pseudo-random noise, hard to compress. */
export function busy(width: number, height: number, seed = 1, alpha = false): Pixels {
  const data = new Uint8ClampedArray(width * height * 4);
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) & 255;
  for (let i = 0; i < width * height; i++) {
    const x = i % width, y = Math.floor(i / width);
    data[i * 4] = (x * 255) / width;
    data[i * 4 + 1] = rnd();
    data[i * 4 + 2] = (y * 255) / height;
    data[i * 4 + 3] = alpha ? (x + y) & 255 : 255;
  }
  return { data, width, height };
}

const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
function chunk(type: string, body: Uint8Array): number[] {
  const t = [...new TextEncoder().encode(type)];
  return [...u32(body.length), ...t, ...body, ...u32(crc32(Uint8Array.from([...t, ...body])))];
}

/** An RGBA PNG; `text` adds a tEXt chunk, which changes the bytes and not the pixels. */
export function png(p: Pixels, text?: string): Uint8Array {
  const raw = new Uint8Array(p.height * (p.width * 4 + 1));
  for (let y = 0; y < p.height; y++) {
    raw[y * (p.width * 4 + 1)] = 0;
    raw.set(p.data.subarray(y * p.width * 4, (y + 1) * p.width * 4), y * (p.width * 4 + 1) + 1);
  }
  const ihdr = Uint8Array.from([...u32(p.width), ...u32(p.height), 8, 6, 0, 0, 0]);
  const parts = [
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    chunk("IHDR", ihdr),
    text ? chunk("tEXt", new TextEncoder().encode(`Comment\0${text}`)) : [],
    chunk("IDAT", zlibSync(raw)),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const wasm = async (spec: string) => WebAssembly.compile(await readFile(fileURLToPath(import.meta.resolve(spec))));

type Encoder = { encode(data: Uint8ClampedArray, width: number, height: number, options: Record<string, unknown>): Uint8Array | null };
async function emscripten(factoryModule: string, wasmSpec: string): Promise<Encoder> {
  const factory = ((await import(factoryModule)) as { default: (o: Record<string, unknown>) => Promise<Encoder> }).default;
  const module = await wasm(wasmSpec);
  return factory({
    noInitialRun: true,
    instantiateWasm: (imports: never, done: (i: WebAssembly.Instance) => void) => {
      const instance = new WebAssembly.Instance(module, imports);
      done(instance);
      return instance.exports;
    },
  });
}

async function options(meta: string): Promise<Record<string, unknown>> {
  return ((await import(meta)) as { defaultOptions: Record<string, unknown> }).defaultOptions;
}

export async function jpeg(p: Pixels, quality = 90): Promise<Uint8Array> {
  const enc = await emscripten("@jsquash/jpeg/codec/enc/mozjpeg_enc.js", "@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm");
  return new Uint8Array(enc.encode(p.data, p.width, p.height, { ...(await options("@jsquash/jpeg/meta.js")), quality })!);
}

export async function avif(p: Pixels): Promise<Uint8Array> {
  const enc = await emscripten("@jsquash/avif/codec/enc/avif_enc.js", "@jsquash/avif/codec/enc/avif_enc.wasm");
  return new Uint8Array(enc.encode(p.data, p.width, p.height, { ...(await options("@jsquash/avif/meta.js")), quality: 50, speed: 10 })!);
}

export async function webp(p: Pixels, quality = 75): Promise<Uint8Array> {
  const enc = await emscripten("@jsquash/webp/codec/enc/webp_enc.js", "@jsquash/webp/codec/enc/webp_enc.wasm");
  return new Uint8Array(enc.encode(p.data, p.width, p.height, { ...(await options("@jsquash/webp/meta.js")), quality })!);
}

const le24 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255];
const le32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];

/** An animated WebP of these still lossy WebP frames (each `RIFF....WEBPVP8 ...`), full canvas. */
export function animatedWebp(frames: Uint8Array[], width: number, height: number): Uint8Array {
  const out: number[] = [];
  out.push(0x56, 0x50, 0x38, 0x58, ...le32(10), 0x02, 0, 0, 0, ...le24(width - 1), ...le24(height - 1));
  out.push(0x41, 0x4e, 0x49, 0x4d, ...le32(6), 0, 0, 0, 0, 0, 0);
  for (const f of frames) {
    const payload = [0, 0, 0, 0, 0, 0, ...le24(width - 1), ...le24(height - 1), ...le24(100), 0, ...f.subarray(12)];
    out.push(0x41, 0x4e, 0x4d, 0x46, ...le32(payload.length), ...payload);
    if (payload.length & 1) out.push(0);
  }
  const body = [0x57, 0x45, 0x42, 0x50, ...out];
  return Uint8Array.from([0x52, 0x49, 0x46, 0x46, ...le32(body.length), ...body]);
}

/** A two-frame animated GIF. */
export function gif(width: number, height: number): Uint8Array {
  const buf = new Uint8Array(width * height * 4 + 2048);
  const w = new GifWriter(buf, width, height, { loop: 0 });
  const palette = Array.from({ length: 256 }, (_, i) => (i << 16) | ((255 - i) << 8) | ((i * 7) & 255));
  for (let f = 0; f < 2; f++) {
    const px = new Uint8Array(width * height);
    for (let i = 0; i < px.length; i++) px[i] = (i * (f + 3) + (i % width)) & 255;
    w.addFrame(0, 0, width, height, px as unknown as number[], { palette, delay: 10 });
  }
  return buf.slice(0, w.end());
}

export const svg = (body = '<rect width="300" height="200" fill="#c33"/><circle cx="150" cy="100" r="80" fill="#36c"/>') =>
  new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200">${body}</svg>`);
