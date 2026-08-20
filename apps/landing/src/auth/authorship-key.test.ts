/**
 * U10 / R17, R18 — warn-and-export for the authorship key (KTD10).
 *
 * The seed in `webvh.ts` signs every Original the user authors and exists only
 * in this browser's localStorage. Before this unit, one click generated it with
 * no warning, and nothing could take it to a second browser. These tests pin
 * the two halves of the remedy: the acknowledgement gate in front of the
 * irreversible step, and a backup that actually restores the SAME DID.
 */
import { describe, test, expect } from 'bun:test';
import * as ed from '@noble/ed25519';
import {
  AuthorshipKeyError,
  BACKUP_FORMAT,
  PBKDF2_ITERATIONS,
  acknowledgeKeyLoss,
  backupFileName,
  classifyRestore,
  decryptAuthorshipKey,
  didFromLog,
  encryptAuthorshipKey,
  exportAuthorshipKey,
  hasAcknowledgedKeyLoss,
  hasAuthorshipKey,
  importAuthorshipKey,
  parseBackupFile,
  readAuthorshipKey,
} from './authorship-key';
import { BrowserWebVHSigner, createUserWebVHDid, ed25519PublicKeyMultibase } from './webvh';

/** A minimal in-memory Storage stand-in — one per simulated browser profile. */
function browser(): Storage & { dump(): Record<string, string> } {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
    dump: () => Object.fromEntries(map),
  } as Storage & { dump(): Record<string, string> };
}

const SUB_ORG = 'sub-org-1234567890abcdef';
const PASSPHRASE = 'correct horse battery staple';

/** Create an identity the way the panel does, warning acknowledged first. */
async function createIdentityIn(storage: Storage, subOrgId = SUB_ORG) {
  acknowledgeKeyLoss(storage, subOrgId);
  return createUserWebVHDid({ subOrgId, email: 'creator@example.com', storage });
}

describe('R17 — the key cannot be generated before the warning is acknowledged', () => {
  test('creating an identity throws until the warning is acknowledged', async () => {
    const storage = browser();
    await expect(
      createUserWebVHDid({ subOrgId: SUB_ORG, email: 'creator@example.com', storage })
    ).rejects.toMatchObject({ code: 'not-acknowledged' });
    // The point of the gate: nothing irreversible happened.
    expect(hasAuthorshipKey(storage, SUB_ORG)).toBe(false);
    expect(storage.dump()).toEqual({});
  });

  test('once acknowledged, the same call mints the key', async () => {
    const storage = browser();
    expect(hasAcknowledgedKeyLoss(storage, SUB_ORG)).toBe(false);
    acknowledgeKeyLoss(storage, SUB_ORG);
    expect(hasAcknowledgedKeyLoss(storage, SUB_ORG)).toBe(true);
    const { did } = await createUserWebVHDid({ subOrgId: SUB_ORG, email: 'c@example.com', storage });
    expect(did.startsWith('did:webvh:')).toBe(true);
    expect(hasAuthorshipKey(storage, SUB_ORG)).toBe(true);
  });

  test('a returning user with a key already is never gated again', async () => {
    const storage = browser();
    const first = await createIdentityIn(storage);
    // Even with the acknowledgement erased, an existing key still resolves.
    storage.removeItem(`originals-authorship-key-ack:${SUB_ORG}`);
    const again = await createUserWebVHDid({ subOrgId: SUB_ORG, email: 'c@example.com', storage });
    expect(again.did).toBe(first.did);
  });
});

describe('R18 — export and restore in another browser', () => {
  test('import reconstructs the same key from an exported payload', async () => {
    const source = browser();
    await createIdentityIn(source);
    const file = await exportAuthorshipKey(source, SUB_ORG, PASSPHRASE);
    const restored = await decryptAuthorshipKey(file, PASSPHRASE);
    expect(restored.seedHex).toBe(readAuthorshipKey(source, SUB_ORG)!.seedHex);
  });

  test('a fresh browser lands on the SAME DID, not merely the same public key', async () => {
    const source = browser();
    const created = await createIdentityIn(source);
    const file = await exportAuthorshipKey(source, SUB_ORG, PASSPHRASE);

    // The SCID is derived from the first log entry's versionTime, so a
    // seed-only backup would re-create a DIFFERENT DID here. Wait past the
    // one-second resolution of that timestamp so this test can tell.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const target = browser();
    const outcome = await importAuthorshipKey(target, SUB_ORG, file, PASSPHRASE);
    expect(outcome.outcome).toBe('fresh');
    expect(outcome.did).toBe(created.did);

    const resumed = await createUserWebVHDid({ subOrgId: SUB_ORG, email: 'c@example.com', storage: target });
    expect(resumed.did).toBe(created.did);

    // …and the restored seed IS the key authorized to append to that DID's log,
    // which is what "can carry on authoring in the new browser" actually means.
    const seed = readAuthorshipKey(target, SUB_ORG)!.seedHex;
    const bytes = Uint8Array.from(seed.match(/../g)!.map((h) => parseInt(h, 16)));
    const publicKeyMultibase = ed25519PublicKeyMultibase(await ed.getPublicKeyAsync(bytes));
    const entries = created.didLog as Array<{ parameters?: { updateKeys?: string[] } }>;
    expect(entries[0].parameters?.updateKeys).toContain(publicKeyMultibase);

    // And it signs: a proof from the restored key verifies under it.
    const signer = new BrowserWebVHSigner(bytes, publicKeyMultibase);
    const message = new TextEncoder().encode('append to my own log');
    const signature = await ed.signAsync(message, bytes);
    expect(await signer.verify(signature, message, await ed.getPublicKeyAsync(bytes))).toBe(true);
  });

  test('a restore over a different key refuses until the replacement is accepted', async () => {
    const source = browser();
    await createIdentityIn(source);
    const file = await exportAuthorshipKey(source, SUB_ORG, PASSPHRASE);

    const target = browser();
    const other = await createIdentityIn(target);
    const before = readAuthorshipKey(target, SUB_ORG)!;
    expect(classifyRestore(before, await decryptAuthorshipKey(file, PASSPHRASE))).toBe('replaces-key');

    await expect(importAuthorshipKey(target, SUB_ORG, file, PASSPHRASE)).rejects.toBeInstanceOf(
      AuthorshipKeyError
    );
    // Refusing must not have touched the key it was about to orphan.
    expect(readAuthorshipKey(target, SUB_ORG)!.seedHex).toBe(before.seedHex);
    expect(didFromLog(readAuthorshipKey(target, SUB_ORG)!.didLog)).toBe(other.did);

    const accepted = await importAuthorshipKey(target, SUB_ORG, file, PASSPHRASE, { allowReplace: true });
    expect(accepted.outcome).toBe('replaces-key');
    expect(readAuthorshipKey(target, SUB_ORG)!.seedHex).not.toBe(before.seedHex);
  });

  test('restoring the same key into the same browser is a no-op, not a replacement', async () => {
    const storage = browser();
    await createIdentityIn(storage);
    const file = await exportAuthorshipKey(storage, SUB_ORG, PASSPHRASE);
    const outcome = await importAuthorshipKey(storage, SUB_ORG, file, PASSPHRASE);
    expect(outcome.outcome).toBe('same-key');
  });
});

describe('the backup file itself', () => {
  test('carries no recoverable seed without the passphrase', async () => {
    const storage = browser();
    await createIdentityIn(storage);
    const seed = readAuthorshipKey(storage, SUB_ORG)!.seedHex;
    const file = await exportAuthorshipKey(storage, SUB_ORG, PASSPHRASE);
    const serialized = JSON.stringify(file);

    const seedBytes = Uint8Array.from(seed.match(/../g)!.map((h) => parseInt(h, 16)));
    const asBase64 = btoa(String.fromCharCode(...seedBytes));
    for (const encoding of [seed, seed.toUpperCase(), asBase64, asBase64.replace(/=+$/, '')]) {
      expect(serialized).not.toContain(encoding);
    }
    // The DID would identify the owner of a file sitting in a Downloads folder.
    expect(serialized).not.toContain('did:webvh:');
    expect(serialized).not.toContain('@example.com');
  });

  test('two exports of the same key share neither salt nor nonce', async () => {
    const storage = browser();
    await createIdentityIn(storage);
    const a = await exportAuthorshipKey(storage, SUB_ORG, PASSPHRASE);
    const b = await exportAuthorshipKey(storage, SUB_ORG, PASSPHRASE);
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.cipher.iv).not.toBe(b.cipher.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  test('declares a KDF cost worth an offline attacker', async () => {
    const file = await encryptAuthorshipKey({ seedHex: 'ab'.repeat(32), didLog: sampleLog() }, PASSPHRASE);
    expect(file.format).toBe(BACKUP_FORMAT);
    expect(file.kdf.name).toBe('PBKDF2');
    expect(file.kdf.hash).toBe('SHA-256');
    expect(file.kdf.iterations).toBe(PBKDF2_ITERATIONS);
    expect(PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(600_000);
    expect(file.cipher.name).toBe('AES-GCM');
    // 16-byte salt, 12-byte nonce, both random per file.
    expect(atob(file.kdf.salt).length).toBe(16);
    expect(atob(file.cipher.iv).length).toBe(12);
  });

  test('the filename carries no email address and no DID', () => {
    const name = backupFileName(new Date('2026-08-19T12:00:00Z'));
    expect(name).toBe('originals-authorship-key-2026-08-19.json');
    expect(name).not.toContain('@');
    expect(name).not.toContain('did:');
  });

  test('a too-short passphrase is refused before anything is encrypted', async () => {
    await expect(
      encryptAuthorshipKey({ seedHex: 'ab'.repeat(32), didLog: sampleLog() }, 'short')
    ).rejects.toMatchObject({ code: 'weak-passphrase' });
  });
});

describe('a failed restore never destroys the key already here', () => {
  async function targetWithKey() {
    const storage = browser();
    const created = await createIdentityIn(storage);
    return { storage, created, before: readAuthorshipKey(storage, SUB_ORG)! };
  }

  test('a wrong passphrase fails and leaves the existing key intact', async () => {
    const source = browser();
    await createIdentityIn(source, 'sub-org-other-000000');
    const file = await encryptAuthorshipKey(
      { seedHex: 'cd'.repeat(32), didLog: sampleLog() },
      PASSPHRASE
    );
    const { storage, created, before } = await targetWithKey();

    await expect(
      importAuthorshipKey(storage, SUB_ORG, file, 'not the passphrase', { allowReplace: true })
    ).rejects.toMatchObject({ code: 'wrong-passphrase' });
    expect(readAuthorshipKey(storage, SUB_ORG)!.seedHex).toBe(before.seedHex);
    expect((await createUserWebVHDid({ subOrgId: SUB_ORG, email: 'c@e.com', storage })).did).toBe(created.did);
  });

  test.each([
    ['not json at all', 'nonsense{'],
    ['json that is not a backup', JSON.stringify({ hello: 'world' })],
    ['a backup with the ciphertext truncated away', 'truncated'],
    ['a backup whose format was renamed', 'renamed'],
  ])('%s is rejected without touching the existing key', async (_label, variant) => {
    const { storage, created, before } = await targetWithKey();
    let text = variant;
    if (variant === 'truncated' || variant === 'renamed') {
      const file = await encryptAuthorshipKey({ seedHex: 'ef'.repeat(32), didLog: sampleLog() }, PASSPHRASE);
      const mangled: Record<string, unknown> = { ...file };
      if (variant === 'truncated') mangled.ciphertext = '';
      else mangled.format = 'something-else';
      text = JSON.stringify(mangled);
    }
    expect(() => parseBackupFile(text)).toThrow(AuthorshipKeyError);
    // And the storage-level path refuses the same payload just as hard.
    await expect(
      importAuthorshipKey(storage, SUB_ORG, safeParse(text), PASSPHRASE, { allowReplace: true })
    ).rejects.toMatchObject({ code: 'malformed-backup' });
    expect(readAuthorshipKey(storage, SUB_ORG)!.seedHex).toBe(before.seedHex);
    expect((await createUserWebVHDid({ subOrgId: SUB_ORG, email: 'c@e.com', storage })).did).toBe(created.did);
  });

  test('a decryptable payload missing the DID log is rejected — a seed alone is not a restore', async () => {
    const { storage, before } = await targetWithKey();
    // Exactly what a seed-only export would produce: valid file, valid
    // passphrase, and nothing that names the DID the Originals were signed under.
    const seedOnly = await encryptAuthorshipKey(
      { seedHex: 'ab'.repeat(32), didLog: [] },
      PASSPHRASE
    );
    await expect(
      importAuthorshipKey(storage, SUB_ORG, seedOnly, PASSPHRASE, { allowReplace: true })
    ).rejects.toMatchObject({ code: 'malformed-backup' });
    expect(readAuthorshipKey(storage, SUB_ORG)!.seedHex).toBe(before.seedHex);
  });
});

describe('no export path transmits key material to the server', () => {
  test('the module reaches for no network primitive', async () => {
    const source = await Bun.file(new URL('./authorship-key.ts', import.meta.url)).text();
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const primitive of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'sendBeacon', 'navigator.', 'import(']) {
      expect(code).not.toContain(primitive);
    }
  });

  test('the panel exports through a local object URL, never a request', async () => {
    const source = await Bun.file(new URL('../components/IdentityPanel.tsx', import.meta.url)).text();
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const primitive of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'sendBeacon']) {
      expect(code).not.toContain(primitive);
    }
    expect(code).toContain('createObjectURL');
  });
});

function sampleLog() {
  return [{ versionId: '1-abc', state: { id: 'did:webvh:Qm123:example.test:user-abc' } }];
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
