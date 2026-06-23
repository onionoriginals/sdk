import * as btc from '@scure/btc-signer';
import { BitcoinTransaction, TransactionInput, TransactionOutput, Utxo, DUST_LIMIT_SATS } from '../types';
import { validateBitcoinAddress } from '../utils/bitcoin-address.js';
import { selectUtxos, SelectionOptions, SelectionResult } from './utxo';

// Regtest uses a different bech32 prefix (bcrt) that is not covered by @scure/btc-signer's
// built-in TEST_NETWORK (which uses 'tb').  We define a minimal network object so that
// address → script derivation works for regtest addresses as well.
// BTC_NETWORK shape is { bech32, pubKeyHash, scriptHash, wif } — same fields as NETWORK/TEST_NETWORK.
const REGTEST_NETWORK: typeof btc.NETWORK = {
  bech32: 'bcrt',
  pubKeyHash: 0x6f,
  scriptHash: 0xc4,
  wif: 0xef,
};

type TransferNetwork = 'mainnet' | 'regtest' | 'signet' | 'testnet';

export function getScureNetwork(network: TransferNetwork): typeof btc.NETWORK {
  switch (network) {
    case 'mainnet':
      return btc.NETWORK;
    case 'regtest':
      return REGTEST_NETWORK;
    case 'signet':
    case 'testnet':
      return btc.TEST_NETWORK;
    default: {
      // Unknown network: fail loudly rather than silently assuming mainnet
      // (real funds). The `never` assignment also makes any future addition to
      // TransferNetwork a compile error until it is explicitly handled above.
      const exhaustiveCheck: never = network;
      throw new Error(`Unsupported Bitcoin network: ${String(exhaustiveCheck)}`);
    }
  }
}

/**
 * Derives the scriptPubKey hex for a given address on the given network.
 * Throws if the address is invalid for that network.
 */
export function addressToScriptPubKey(address: string, network: typeof btc.NETWORK): string {
  const decoded = btc.Address(network).decode(address);
  const script = btc.OutScript.encode(decoded);
  return Buffer.from(script).toString('hex');
}

/**
 * Convenience wrapper that derives the hex-encoded scriptPubKey for an address
 * using the SDK's configured Bitcoin network name (rather than the @scure
 * network object). Throws if the address is invalid for that network.
 *
 * For `regtest` this mirrors `validateBitcoinAddress`'s leniency: regtest tooling
 * commonly uses testnet-format (`tb1`/base58 testnet) addresses, so if decoding
 * against the strict regtest (`bcrt`) parameters fails we fall back to the
 * testnet parameters before giving up.
 */
export function scriptPubKeyForAddress(
  address: string,
  network: TransferNetwork = 'mainnet'
): string {
  try {
    return addressToScriptPubKey(address, getScureNetwork(network));
  } catch (error) {
    if (network === 'regtest') {
      return addressToScriptPubKey(address, btc.TEST_NETWORK);
    }
    throw error;
  }
}

export interface BuildTransferOptions extends Omit<SelectionOptions, 'targetAmountSats' | 'feeRateSatsPerVb'> {
  changeAddress?: string;
  /** Bitcoin network for address validation and scriptPubKey derivation (default: 'mainnet') */
  network?: TransferNetwork;
}

export function buildTransferTransaction(
  availableUtxos: Utxo[],
  recipientAddress: string,
  amountSats: number,
  feeRateSatsPerVb: number,
  options: BuildTransferOptions = {}
): { tx: BitcoinTransaction; selection: SelectionResult } {
  const network = options.network ?? 'mainnet';
  const scureNetwork = getScureNetwork(network);

  // Map 'signet' and 'regtest' to 'mainnet'/'regtest'/'signet' as supported by validateBitcoinAddress.
  // validateBitcoinAddress accepts 'mainnet' | 'regtest' | 'signet' — testnet maps to signet (same prefix).
  const validateNetwork: 'mainnet' | 'regtest' | 'signet' =
    network === 'testnet' ? 'signet' : network;

  // Validate recipient address
  validateBitcoinAddress(recipientAddress, validateNetwork);

  // Validate change address if explicitly provided
  if (options.changeAddress) {
    validateBitcoinAddress(options.changeAddress, validateNetwork);
  }

  const selection = selectUtxos(availableUtxos, {
    targetAmountSats: amountSats,
    feeRateSatsPerVb,
    allowLocked: options.allowLocked,
    forbidInscriptionBearingInputs: options.forbidInscriptionBearingInputs,
    changeAddress: options.changeAddress,
    feeEstimate: options.feeEstimate
  });

  const vin: TransactionInput[] = selection.selected.map(u => ({ txid: u.txid, vout: u.vout }));

  const outputs: TransactionOutput[] = [];

  // Derive real scriptPubKey for recipient
  const recipientScript = addressToScriptPubKey(recipientAddress, scureNetwork);
  outputs.push({ value: amountSats, scriptPubKey: recipientScript, address: recipientAddress });

  if (selection.changeSats >= DUST_LIMIT_SATS) {
    // Resolve change address: prefer explicit option, then fall back to an address found on
    // a selected input.  If neither is available, throw — emitting a placeholder would be
    // worse than failing loudly.
    const changeAddress =
      options.changeAddress ??
      selection.selected.find(u => !!u.address)?.address;

    if (!changeAddress) {
      throw new Error(
        'changeAddress is required when a change output is needed and no input address is available'
      );
    }

    const changeScript = addressToScriptPubKey(changeAddress, scureNetwork);
    outputs.push({ value: selection.changeSats, scriptPubKey: changeScript, address: changeAddress });
  }

  const tx: BitcoinTransaction = {
    txid: '',
    vin,
    vout: outputs,
    fee: selection.feeSats
  };

  return { tx, selection };
}
