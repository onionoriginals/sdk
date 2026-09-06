import { expect, test } from 'bun:test';
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import {
  prepareInscriptionOnSat,
  submitPreparedInscriptionOnSat,
  type OrdinalsProvider,
  type InscriptionRecoveryRecord,
} from '../../src/index.js';

const key = new Uint8Array(32).fill(17);
const network = { ...btc.TEST_NETWORK, bech32: 'bcrt' };
const owner = btc.p2wpkh(secp256k1.getPublicKey(key), network);
const attacker = btc.p2wpkh(secp256k1.getPublicKey(new Uint8Array(32).fill(18)), network);
const funding = () => [
  { txid: '11'.repeat(32), vout: 0, value: 600, scriptPubKey: Buffer.from(owner.script).toString('hex') },
  { txid: '22'.repeat(32), vout: 1, value: 100_000, scriptPubKey: Buffer.from(owner.script).toString('hex') },
];

test.each(['replace-identity', 'reorder-inputs', 'redirect-commit', 'redirect-change'] as const)(
  'public inscription custody rejects a validly signed %s transaction before persistence or broadcast',
  async attack => {
    const fundingUtxos = funding();
    const originalFunding = structuredClone(fundingUtxos);
    const lookedUp: Array<{ txid: string; vout: number }> = [];
    const encodedSats: string[] = [];
    const broadcasts: unknown[] = [];
    const saved: InscriptionRecoveryRecord[] = [];
    const provider = {
      async getFirstSatOfOutput(outpoint: { txid: string; vout: number }) {
        lookedUp.push({ ...outpoint }); return '5000000000';
      },
      async broadcastTransaction(raw: unknown) { broadcasts.push(raw); return 'ff'.repeat(32); },
    } as unknown as OrdinalsProvider;
    let attackerSigned = false;
    const attempt = async () => {
      const prepared = await prepareInscriptionOnSat({
        provider, network: 'regtest', fundingUtxos, changeAddress: owner.address!, feeRate: 2,
        async buildContent(sat) {
          encodedSats.push(sat);
          return { content: new TextEncoder().encode(`did:btco:reg:${sat}`), contentType: 'text/plain' };
        },
        satSigner: { async signAndFinalizeCommitPsbt(psbt) {
          const original = btc.Transaction.fromPSBT(Buffer.from(psbt, 'base64'), { allowUnknownOutputs: true });
          const malicious = new btc.Transaction({ allowUnknownOutputs: true });
          const inputs = [original.getInput(0), original.getInput(1)];
          if (attack === 'reorder-inputs') inputs.reverse();
          for (let index = 0; index < inputs.length; index++) {
            malicious.addInput(attack === 'replace-identity' && index === 0
              ? { ...inputs[index], txid: Buffer.from('33'.repeat(32), 'hex') }
              : inputs[index]);
          }
          for (let index = 0; index < original.outputsLength; index++) {
            const redirected = (attack === 'redirect-commit' && index === 0) || (attack === 'redirect-change' && index === 1);
            malicious.addOutput({ ...original.getOutput(index), ...(redirected ? { script: attacker.script } : {}) });
          }
          malicious.sign(key); malicious.finalize(); attackerSigned = true;
          return malicious.hex;
        } },
      });
      return submitPreparedInscriptionOnSat({ prepared, provider, recoveryStore: {
        async save(record) { saved.push(structuredClone(record)); }, async load() { return undefined; },
      } });
    };
    await expect(attempt()).rejects.toMatchObject({ code: 'COMMIT_TX_MISMATCH' });
    expect(attackerSigned).toBe(true); // Valid Bitcoin signing alone must not authorize different custody.
    expect(lookedUp).toEqual([{ txid: originalFunding[0].txid, vout: originalFunding[0].vout }]);
    expect(encodedSats).toEqual(['5000000000']);
    expect(fundingUtxos).toEqual(originalFunding);
    expect(saved).toEqual([]);
    expect(broadcasts).toEqual([]);
  },
);
