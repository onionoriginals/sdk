/**
 * Shared by the `--target local` dry-run phases (Bun): the landing engine
 * against the loopback host started by local-server.ts, with a FileStore per
 * client so a "restart" is a new process on the same directory.
 *
 * The author is a did:webvh built by the landing's own builder, with the app's
 * two key roles (#key-0 identity and alias control, #key-1 authorship; P3.7,
 * P5.11). Its secrets come from a custody file standing in for Turnkey. A dry
 * run is never a section B receipt: Turnkey and a public host are what B proves.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OriginalsError } from "@originals/vh";
import { keySigner, type HostedFetch } from "@originals/sdk/originals";
import { FileStore } from "@originals/sdk/originals/fs";
import { signToken, getAuthCookieConfig } from "@originals/auth/server";
import { DemoEngine, type Authoring, type PublishTarget } from "../../../apps/landing/src/sdk/engine.ts";
import { DurableHostingStorageAdapter } from "../../../apps/landing/src/sdk/durable-hosting-adapter.ts";
import type { PublicationRecord } from "../../../apps/landing/src/sdk/idb-store.ts";
import { BrowserWebVHSigner, ed25519PublicKeyMultibase, userWebvhSlug } from "../../../apps/landing/src/auth/webvh.ts";
import { serializeCookie } from "../../../apps/landing/server/cookies.ts";
import * as ed from "@noble/ed25519";

export interface LocalInput {
  dirs: Record<string, string>;
  port: number;
  domain: string;
  sub: string;
  jwtSecret: string;
}

export function cookieFor(input: LocalInput): string {
  return serializeCookie(getAuthCookieConfig(signToken(input.sub, `${input.sub}@acceptance.invalid`, undefined, { secret: input.jwtSecret })));
}

/** A browser signed in as the test account, talking to the loopback app. */
export function uploader(input: LocalInput, sub = input.sub): DurableHostingStorageAdapter {
  const cookie = cookieFor({ ...input, sub });
  const fetchImpl = ((url: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("cookie", cookie);
    return fetch(url, { ...init, headers });
  }) as typeof fetch;
  return new DurableHostingStorageAdapter({ baseUrl: `http://127.0.0.1:${input.port}`, fetchImpl });
}

/** A stranger's read of the alias's public URLs, answered by the loopback host under the alias's own host name. */
export function strangerRead(input: LocalInput): HostedFetch {
  return async (url, options) => {
    const u = new URL(url);
    const res = await fetch(`http://127.0.0.1:${input.port}${u.pathname}`, { headers: { host: u.host }, signal: options?.signal, redirect: "error" });
    if (!res.ok) throw new OriginalsError("unavailable-bytes", "FETCH_STATUS", `${url} answered ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  };
}

export interface Custody {
  did: string;
  versionId: string;
  log: string;
  identitySecretHex: string;
  authorshipSecretHex: string;
}

export function readCustody(input: LocalInput): Custody {
  return JSON.parse(readFileSync(join(input.dirs.custody, "author-keys.json"), "utf8")) as Custody;
}

export function authoring(c: Custody): Authoring {
  const verificationMethod = `${c.did}#key-1`;
  return {
    ref: { did: c.did, verificationMethod, versionId: c.versionId },
    signer: keySigner({ keyType: "Ed25519", secretKey: Uint8Array.from(Buffer.from(c.authorshipSecretHex, "hex")), verificationMethod }),
    evidence: { did: c.did, log: c.log },
  };
}

export async function identitySigner(c: Custody): Promise<BrowserWebVHSigner> {
  const secret = Uint8Array.from(Buffer.from(c.identitySecretHex, "hex"));
  return new BrowserWebVHSigner(secret, ed25519PublicKeyMultibase(await ed.getPublicKeyAsync(secret)));
}

/** A FileStore that also keeps publication records, as the browser's IndexedDbStore does (G4). */
export async function clientStore(dir: string) {
  const store = await FileStore.open(dir);
  const records = join(dir, "publications");
  mkdirSync(records, { recursive: true });
  const file = (did: string) => join(records, `${createHash("sha256").update(did).digest("hex")}.json`);
  return Object.assign(store, {
    getPublication: async (did: string): Promise<PublicationRecord | undefined> => (existsSync(file(did)) ? (JSON.parse(readFileSync(file(did), "utf8")) as PublicationRecord) : undefined),
    putPublication: async (did: string, record: PublicationRecord): Promise<void> => writeFileSync(file(did), JSON.stringify(record)),
  });
}

/** The signed-in engine for one client: its own store directory, the custody author, the loopback host. */
export async function signedInEngine(input: LocalInput, storeDir: string, opts: { custody?: Custody; upload?: PublishTarget["upload"] } = {}) {
  const custody = opts.custody ?? readCustody(input);
  const store = await clientStore(storeDir);
  const aliasSigner = await identitySigner(custody);
  const engine = new DemoEngine({
    authed: true,
    subOrgId: input.sub,
    // The staging build's switch, standing in for VITE_ACCEPTANCE_HOSTED_PUBLICATION (G7).
    features: { hostedPublication: true },
    openStore: async () => store,
    author: async () => authoring(custody),
    publishTarget: { upload: opts.upload ?? uploader(input), read: strangerRead(input), domain: input.domain, slug: userWebvhSlug(input.sub), aliasSigner: async () => aliasSigner },
  });
  return { engine, store, custody };
}

/** Deterministic test bytes: a real PNG (1x1) and a text body. */
export const PNG = Uint8Array.from(Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5c8a26f0000000049454e44ae426082", "hex"));
export const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
