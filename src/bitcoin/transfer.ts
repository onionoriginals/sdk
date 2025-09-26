import { BitcoinTransaction, TransactionInput, TransactionOutput, Utxo, DUST_LIMIT_SATS } from '../types';
import { estimateFeeSats, selectUtxos, SelectionOptions, SelectionResult } from './utxo';

export interface BuildTransferOptions extends Omit<SelectionOptions, 'targetAmountSats' | 'feeRateSatsPerVb'> {
  changeAddress?: string;
}

export function buildTransferTransaction(
  availableUtxos: Utxo[],
  recipientAddress: string,
  amountSats: number,
  feeRateSatsPerVb: number,
  options: BuildTransferOptions = {}
): { tx: BitcoinTransaction; selection: SelectionResult } {
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
  outputs.push({ value: amountSats, scriptPubKey: 'script', address: recipientAddress });

  if (selection.changeSats >= DUST_LIMIT_SATS) {
    const changeAddress = options.changeAddress || (selection.selected.find(u => !!u.address)?.address ?? 'change');
    outputs.push({ value: selection.changeSats, scriptPubKey: 'script', address: changeAddress });
  }

  const tx: BitcoinTransaction = {
    txid: 'mock-built-txid',
    vin,
    vout: outputs,
    fee: selection.feeSats
  };

  return { tx, selection };
}

