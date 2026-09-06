import { expect, test } from 'bun:test';
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ensureBitcoinFundingAccount, fundingSignerAddress, type TurnkeyBitcoinClient } from './turnkey-session';

const publicKey = secp256k1.getPublicKey(new Uint8Array(32).fill(4), true);
const tb = btc.p2wpkh(publicKey, btc.TEST_NETWORK).address!;
const reg = btc.p2wpkh(publicKey, { ...btc.TEST_NETWORK, bech32: 'bcrt' }).address!;

test('regtest reuses the testnet witness key with a checksummed bcrt address and original signer identity', async () => {
  const client = { async getWalletAccounts() { return { accounts: [{ path: "m/84'/1'/0'/0/0", address: tb }] }; } } as unknown as TurnkeyBitcoinClient;
  expect(await ensureBitcoinFundingAccount(client, 'sub', 'regtest')).toBe(reg);
  expect(fundingSignerAddress(reg)).toBe(tb);
  expect(fundingSignerAddress(tb)).toBe(tb);
});

test('invalid checksums are refused before showing a regtest deposit or asking to sign', async () => {
  const bad = tb.slice(0, -1) + (tb.endsWith('a') ? 'b' : 'a');
  const client = { async getWalletAccounts() { return { accounts: [{ path: "m/84'/1'/0'/0/0", address: bad }] }; } } as unknown as TurnkeyBitcoinClient;
  await expect(ensureBitcoinFundingAccount(client, 'sub', 'regtest')).rejects.toThrow();
  expect(() => fundingSignerAddress(reg.slice(0, -1) + (reg.endsWith('a') ? 'b' : 'a'))).toThrow();
});
