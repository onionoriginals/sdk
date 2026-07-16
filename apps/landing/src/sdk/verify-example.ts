/**
 * Live verification of the shipped real example ("First Light").
 *
 * The artifacts under public/example/ were minted once with the real SDK
 * (scripts/make-example.ts): real Ed25519 keys, a real did:cel genesis with a
 * signed CEL event log, a real did:webvh identity with a signed version-history
 * log, and a signed publication credential. This module re-verifies all of it
 * in the visitor's browser — hash recomputation, did:webvh-log proof-chain
 * verification via didwebvh-ts, and did:cel-log + credential signature
 * verification via the SDK — so the page never asks anyone to take its word.
 */
import '../shims/buffer-global';
import {
  OriginalsSDK,
  OrdMockProvider,
  MemoryStorageAdapter,
  Ed25519Verifier,
  resolveDidCel
} from '@originals/sdk';
import { resolveDIDFromLog } from 'didwebvh-ts';
import { sha256 } from '@noble/hashes/sha2.js';

import { realExample } from '../content';
import manifestJson from '../../public/example/manifest.json';
import credentialJson from '../../public/example/credential.json';
import artworkSvg from '../../public/example/artwork.svg?raw';
import didLogRaw from '../../public/example/did-log.jsonl?raw';
import celLogJson from '../../public/example/cel-log.json';

export interface ExampleCheck {
  id: 'hash' | 'log' | 'credential';
  ok: boolean;
  detail: string;
}

export interface VerifiedExample {
  title: string;
  medium: string;
  artworkDataUri: string;
  dids: { cel: string; webvh: string };
  credentialTypes: string[];
  issuedAt?: string;
  checks: ExampleCheck[];
  allOk: boolean;
}

interface Manifest {
  title: string;
  medium: string;
  dids: Record<string, string>;
  resources: Array<{ id: string; contentType: string; hash: string }>;
}

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

const short = (did: string) => (did.length > 42 ? `${did.slice(0, 36)}…` : did);

export async function verifyExample(): Promise<VerifiedExample> {
  const manifest = manifestJson as unknown as Manifest;
  const credential = credentialJson as unknown as {
    type: string[];
    issuer: string | { id: string };
    validFrom?: string;
    issuanceDate?: string;
    credentialSubject: { id?: string };
  };
  const checks: ExampleCheck[] = [];

  // 1 · Content integrity: recompute the artwork's sha-256 from its bytes.
  const svgBytes = new TextEncoder().encode(artworkSvg);
  const recomputed = toHex(sha256(svgBytes));
  const declared = manifest.resources.find((r) => r.id === 'artwork.svg')?.hash;
  checks.push({
    id: 'hash',
    ok: recomputed === declared,
    detail: `sha-256 recomputed from ${svgBytes.length} bytes → ${recomputed.slice(0, 20)}…`
  });

  // 2 · Identity: verify the did:webvh log's SCID + Ed25519 proof chain and
  //     derive the DID document from it (no server, no trust in this page).
  const logEntries = didLogRaw
    .trim()
    .split('\n')
    .map((line: string) => JSON.parse(line));
  let didDocument: Record<string, unknown> | null = null;
  let resolvedDid = '';
  try {
    const resolved = (await resolveDIDFromLog(logEntries as never, {
      verifier: new Ed25519Verifier()
    } as never)) as unknown as { did?: string; doc?: Record<string, unknown> };
    resolvedDid = resolved.did ?? (resolved.doc?.id as string) ?? '';
    didDocument = resolved.doc ?? null;
  } catch (err) {
    console.error('[originals-sdk] example DID log verification failed', err);
  }
  const logOk = !!didDocument && resolvedDid === manifest.dids['did:webvh'];
  checks.push({
    id: 'log',
    ok: logOk,
    detail: logOk
      ? `${logEntries.length} signed log ${logEntries.length === 1 ? 'entry' : 'entries'} verified → ${short(resolvedDid)}`
      : realExample.checkFailDetails.log
  });

  // 3 · Provenance: the publication credential is issued and self-signed by the
  //     asset's did:cel genesis identity. Re-derive that identity from the
  //     shipped CEL log — resolveDidCel verifies the WHOLE signed chain and binds
  //     the DID to it (returns null otherwise) — then verify the credential's
  //     signature against the derived key material. No server, no trust in us.
  let credentialOk = false;
  const celDid = manifest.dids['did:cel'];
  try {
    const celDoc = celDid
      ? await resolveDidCel(celDid, celLogJson as never)
      : null;
    if (celDoc) {
      const sdk = OriginalsSDK.create({
        network: 'regtest',
        webvhNetwork: 'magby',
        defaultKeyType: 'Ed25519',
        ordinalsProvider: new OrdMockProvider(),
        storageAdapter: new MemoryStorageAdapter(),
        enableLogging: false
      } as unknown as Parameters<typeof OriginalsSDK.create>[0]);
      await sdk.did.cache.set(celDid, celDoc as never);
      const signatureOk = await sdk.credentials.verifyCredential(credential as never);
      const issuer =
        typeof credential.issuer === 'string' ? credential.issuer : credential.issuer.id;
      credentialOk =
        signatureOk &&
        issuer === celDid &&
        credential.credentialSubject.id === celDid;
    }
  } catch (err) {
    console.error('[originals-sdk] example credential verification failed', err);
  }
  checks.push({
    id: 'credential',
    ok: credentialOk,
    detail: credentialOk
      ? `${credential.type.join(' · ')} — signature valid, issuer matches the verified DID`
      : realExample.checkFailDetails.credential
  });

  const result: VerifiedExample = {
    title: manifest.title,
    medium: manifest.medium,
    artworkDataUri: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(artworkSvg)}`,
    dids: { cel: manifest.dids['did:cel'], webvh: manifest.dids['did:webvh'] },
    credentialTypes: credential.type,
    issuedAt: credential.validFrom ?? credential.issuanceDate,
    checks,
    allOk: checks.every((c) => c.ok)
  };
  console.log(
    '%c[originals-sdk] real-example verification',
    'color:#f7931a;font-weight:600;font-family:ui-monospace,monospace',
    checks
  );
  return result;
}
