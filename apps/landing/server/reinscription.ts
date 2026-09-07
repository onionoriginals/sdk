import * as btc from '@scure/btc-signer';
import { OriginalsSDK, parseDocument, verifyHistory, digestBytes, type OrdinalsProvider } from '@originals/sdk';

/** Recognize only the single, unambiguous inscription envelope emitted by the CEL 3 writer. */
function readPublication(reveal: btc.Transaction) {
  const witness = reveal.getInput(0).finalScriptWitness;
  if (!witness || witness.length !== 3 || witness[0].length !== 64 || witness[2].length !== 33) throw new Error('Unsupported reveal witness');
  const ops = btc.Script.decode(witness[1]);
  const bytes = (value: unknown): value is Uint8Array => value instanceof Uint8Array;
  if (!bytes(ops[0]) || ops[0].length !== 32 || ops[1] !== 'CHECKSIG' || ops[2] !== 0 || ops[3] !== 'IF' ||
      !bytes(ops[4]) || new TextDecoder().decode(ops[4]) !== 'ord' || ops.at(-1) !== 'ENDIF') throw new Error('Unsupported inscription script');
  let contentType: string | undefined;
  const metadata: Uint8Array[] = [], body: Uint8Array[] = [];
  let offset = 5;
  for (; offset < ops.length - 1 && ops[offset] !== 0; offset += 2) {
    const tag = ops[offset], value = ops[offset + 1];
    if (!bytes(tag) || tag.length !== 1 || !bytes(value)) throw new Error('Invalid inscription tag');
    if (tag[0] === 1 && contentType === undefined) contentType = new TextDecoder('utf-8', { fatal: true }).decode(value);
    else if (tag[0] === 5) metadata.push(value);
    else throw new Error('Unsupported or duplicate inscription tag');
  }
  if (!contentType || ops[offset++] !== 0) throw new Error('Inscription content is missing');
  for (; offset < ops.length - 1; offset++) {
    const part = ops[offset];
    if (!bytes(part)) throw new Error('Additional script or inscription envelope');
    body.push(part);
  }
  const concat = (parts: Uint8Array[]) => {
    const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
    let start = 0; for (const part of parts) { result.set(part, start); start += part.length; }
    return result;
  };
  const content = concat(body);
  if (!metadata.length && contentType !== 'application/cel') throw new Error('CEL document required');
  return { document: parseDocument(metadata.length ? concat(metadata) : content, metadata.length ? 'cbor' : 'json'), contentType, content, media: metadata.length > 0 };
}

/** Permit deliberate CEL continuation only after fresh sat authority and exact sat placement checks. */
export async function isAuthorizedReinscription(input: {
  provider: OrdinalsProvider;
  network: 'mainnet' | 'testnet' | 'regtest';
  identity: { txid: string; vout: number };
  reveal: btc.Transaction;
  address: string;
  inscriptionIds: () => Promise<string[]>;
}): Promise<boolean> {
  try {
    if (!input.provider.getFirstSatOfOutput || input.reveal.outputsLength !== 1 || (input.reveal.getOutput(0).amount ?? 0n) < 1n) return false;
    const publication = readPublication(input.reveal);
    const sat = await input.provider.getFirstSatOfOutput(input.identity);
    const sdk = OriginalsSDK.create({ network: input.network, ordinalsProvider: input.provider });
    const accepted = await sdk.lifecycle.resolveAssetFromSat(sat);
    if (accepted.status !== 'accepted' || accepted.resolution.pending.length ||
        accepted.resolution.ownership.satpoint !== `${input.identity.txid.toLowerCase()}:${input.identity.vout}:0` ||
        accepted.resolution.ownership.owner !== input.address ||
        publication.document.log[0]?.event.previousEvent !== accepted.asset.state.head) return false;
    const sameSatIds = new Set([...accepted.resolution.publications.map(publication => publication.inscriptionId), ...accepted.resolution.diagnostics.map(diagnostic => diagnostic.inscriptionId)]);
    const inputIds = await input.inscriptionIds();
    if (!inputIds.length || inputIds.some(id => !sameSatIds.has(id))) return false;
    const verified = verifyHistory({ log: [...accepted.asset.celLog.log, ...publication.document.log] }, { expectedDid: accepted.asset.id });
    if (verified.state.alias !== accepted.asset.state.alias || verified.state.entryCount <= accepted.asset.state.entryCount) return false;
    if (publication.media && !verified.state.resources.some(resource => resource.mediaType === publication.contentType && resource.digestMultibase === digestBytes(publication.content))) return false;
    return true;
  } catch { return false; }
}
