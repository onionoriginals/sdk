import { entropyToMnemonic, mnemonicToEntropy, mnemonicToSeed } from "../../../lib/crypto/mnemonic";
import { describe, expect, test } from "bun:test";
import vectors from '../../fixtures/crypto/mnemonic.json'

describe('mnemonic tests', () => {
  test('can generate 12 words', () => {
    for (const vector of vectors.english) {
        const mnemonic = entropyToMnemonic(vector[0])
        expect(mnemonic).toBe(vector[1])
    }
  })

  test('can recover 12 words', () => {
    for (const vector of vectors.english) {
        const entropy = mnemonicToEntropy(vector[1])
        expect(entropy).toBe(vector[0])
    }
  })

  test('can convert 12 words to seed hex', () => {
    for (const vector of vectors.english) {
        const seed = mnemonicToSeed(vector[1], "TREZOR")
        expect(seed).toBe(vector[2])
    }
  })
})