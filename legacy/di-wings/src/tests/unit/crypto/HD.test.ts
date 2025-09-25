import { deriveKeyAtPathFromMaster, seedToHD } from "../../../lib/crypto/keypairs/HD";
import { describe, expect, it } from "bun:test";
import hdFixtures from '../../fixtures/crypto/HD.json';
import { mnemonicToSeed } from "../../../lib/crypto/mnemonic";
import { MULTICODEC_SECP256K1_PUB_HEADER, multibase } from "../../../lib/crypto";

describe('HD tests', () => {
  let i = 0;
  for (const vector of hdFixtures.secp256k1) {
    it(`${i}: can convert hex seed (${vector[0].slice(0, 12)}...) to xpriv (${vector[2].slice(0, 12)}...) with path ${vector[1]}`, () => {
        const key = seedToHD(vector[0])
        const derived = deriveKeyAtPathFromMaster(key, vector[1])
        expect(derived.privateExtendedKey).toBe(vector[2])
    })
    i++
  }
})
