/**
 * The landing's hosted journey on fixtures (plan 011, PR 8): an author
 * publishes through the real server routes and store, and a stranger with no
 * key reads the Original back through its did:webvh alias and verifies the
 * exact snapshot (P3.6, P9.1). The alias log is built by didwebvh-ts and
 * verified by @originals/vh.
 */
import { describe, expect, test } from 'bun:test';
import * as ed from '@noble/ed25519';
import { MemoryStore, OriginalsSDK } from '@originals/sdk/originals';
import { BrowserWebVHSigner, ed25519PublicKeyMultibase, userWebvhSlug } from '../auth/webvh';
import { createLocalAuthor } from './local-author';
import { aliasName, publishOriginal } from './publish';
import { DOMAIN, SUB, host } from './publish.fixture';

async function authored() {
  const author = await createLocalAuthor(new Date('2026-10-20T10:00:00Z'));
  let t = Date.parse('2026-10-20T10:00:01Z');
  const sdk = OriginalsSDK.create({ store: new MemoryStore(), authors: [author.evidence], freshness: 'asserted', clock: () => (t += 250) });
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>');
  const c = await sdk.create({ name: 'Harbor at dawn', resources: [{ id: 'artwork.svg', mediaType: 'image/svg+xml', bytes: svg }], author: author.ref, signer: author.signer });
  if (c.kind !== 'original') throw new Error('expected an Original');
  const secret = ed.utils.randomSecretKey();
  const aliasSigner = new BrowserWebVHSigner(secret, ed25519PublicKeyMultibase(await ed.getPublicKeyAsync(secret)));
  return { author, sdk, aliasSigner, did: c.original.did, head: c.original.checkpoint };
}

describe('publishing from the landing (plan 011, PR 8)', () => {
  test('a stranger reads the published Original through its did:webvh and verifies the exact snapshot', async () => {
    const { upload, read } = host();
    const { author, sdk, aliasSigner, did, head } = await authored();
    const slug = userWebvhSlug(SUB);
    const published = await publishOriginal({ sdk, did, parent: head, author: author.ref, signer: author.signer, aliasSigner, domain: DOMAIN, slug, hosting: upload });

    expect(published.alias.did).toMatch(new RegExp(`^did:webvh:[^:]+:${DOMAIN}:${slug}:${aliasName(did)}$`));
    expect(published.baseUrl).toBe(`https://${DOMAIN}/${slug}/${aliasName(did)}/`);
    expect(published.commit?.original.report.aliases).toEqual([{ did: published.alias.did, status: 'confirmed' }]);

    const stranger = OriginalsSDK.create({ store: new MemoryStore(), authors: [], clock: () => Date.parse('2026-10-20T11:00:00Z') });
    const r = await stranger.loadPublished(published.alias.did, read);
    expect(r.verified, JSON.stringify(r.reasons)).toBe(true);
    expect(r.report.original).toBe(did);
    expect(r.report.state?.name).toBe('Harbor at dawn');
    expect(r.alias.status).toBe('confirmed');
    expect(r.report.resources.versions.map((v) => v.bytes)).toEqual(['verified']);
  });

  test('a retry with the same alias repeats the same snapshot and appends nothing (P9.2)', async () => {
    const { upload, read } = host();
    const { author, sdk, aliasSigner, did, head } = await authored();
    const slug = userWebvhSlug(SUB);
    const first = await publishOriginal({ sdk, did, parent: head, author: author.ref, signer: author.signer, aliasSigner, domain: DOMAIN, slug, hosting: upload });
    const checkpoint = (await sdk.get(did)).checkpoint;
    const again = await publishOriginal({ sdk, did, parent: checkpoint, author: author.ref, signer: author.signer, aliasSigner, domain: DOMAIN, slug, hosting: upload, alias: first.alias });
    expect(again.commit).toBeNull();
    expect((await sdk.get(did)).checkpoint).toBe(checkpoint);
    const stranger = OriginalsSDK.create({ store: new MemoryStore(), authors: [], clock: () => Date.parse('2026-10-20T11:00:00Z') });
    expect((await stranger.loadPublished(first.alias.did, read)).verified).toBe(true);
  });

  test('the host refuses to publish into another author\'s namespace', async () => {
    const { upload } = host();
    const { author, sdk, aliasSigner, did, head } = await authored();
    await expect(
      publishOriginal({ sdk, did, parent: head, author: author.ref, signer: author.signer, aliasSigner, domain: DOMAIN, slug: userWebvhSlug('someone-else-0001'), hosting: upload }),
    ).rejects.toThrow(/403/);
  });
});
