/** Real PNG bytes for the acceptance journey's one resource (P4.1): 48x48 RGB of random pixels, so they do not compress away. */
import { deflateSync } from "node:zlib";
import { crc32 } from "@originals/sdk/originals";

const utf8 = (text) => new TextEncoder().encode(text);

export function png(seedBytes = crypto.getRandomValues(new Uint8Array(48 * 48 * 3))) {
  const width = 48;
  const height = 48;
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++) raw.set(seedBytes.subarray(y * width * 3, (y + 1) * width * 3), y * (1 + width * 3) + 1);
  const chunk = (type, data) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(utf8(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, width);
  new DataView(ihdr.buffer).setUint32(4, height);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const parts = [Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())];
  return Uint8Array.from(parts.flatMap((p) => [...p]));
}
