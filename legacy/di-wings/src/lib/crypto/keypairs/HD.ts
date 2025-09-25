import { hexToBytes } from "@noble/hashes/utils"
import { HDKey } from "@scure/bip32"

export const seedToHD = (seed: string) => {
  return HDKey.fromMasterSeed(hexToBytes(seed)).privateExtendedKey;
}

export const deriveKeyAtPathFromMaster = (masterKey: string, path: string): HDKey => {
  return HDKey.fromExtendedKey(masterKey).derive(path);
}