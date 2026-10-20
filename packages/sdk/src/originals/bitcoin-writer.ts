/**
 * Writing an anchored Original to Bitcoin (plan 011 PR 10; plan 012).
 *
 * - `prepareEntryInscription` builds the commit and reveal that inscribe the
 *   Original's stored head entry on its anchoring sat, as one complete entry
 *   of `application/vnd.originals.vh+jsonl` (owner decision Q15). The first
 *   funding UTXO must hold that sat at offset 0: the anchoring sat for the
 *   anchoring entry (P9.10), and the output now holding it for every later
 *   entry, which is how only the sat's holder can extend an anchored Original
 *   while only the author can sign it (P9.12). Nothing is re-signed: the entry
 *   is the one already committed locally (P9.6). The head must be the next
 *   entry Bitcoin can accept: the anchoring entry until Bitcoin shows the
 *   anchor, then the entry after the head Bitcoin shows (P9.13).
 * - Submitting and retrying are the sat builder's durable state machine:
 *   `submitPreparedInscriptionOnSat` persists before every broadcast, and
 *   `resumeInscriptionOnSat` rebroadcasts the same pair. A replacement is a
 *   new `prepareEntryInscription`, never a silent re-sign (P9.6).
 * - `readAnchored` reads the sat back. The published boundary is what Bitcoin
 *   shows, under the 1-confirmation policy (decision D): a broadcast or
 *   pending transaction never advances it (P9.4).
 */
import { OriginalsError } from "@originals/vh";
import { ORIGINALS_INSCRIPTION_TYPE, anchoringIndex, parseBtcoAlias } from "@originals/vh/originals";
import type { OrdinalsProvider } from "../adapters/types.js";
import { prepareInscriptionOnSat, type InscribeOnSatParams, type PreparedInscriptionOnSat } from "../bitcoin/inscribe-on-sat.js";
import { readEvidence } from "./evidence.js";
import { InscriptionClock, satEvidence } from "./bitcoin.js";
import type { OriginalView, OriginalsSDK } from "./sdk.js";

export { submitPreparedInscriptionOnSat, resumeInscriptionOnSat } from "../bitcoin/inscribe-on-sat.js";

function refuse(category: "invalid-evidence" | "incomplete-evidence", code: string, message: string): never {
  throw new OriginalsError(category, code, message);
}

interface StoredHead {
  line: string;
  versionId: string;
  sat: ReturnType<typeof parseBtcoAlias>;
  /** The stored log's entries, oldest first. */
  entries: Array<{ versionId: string }>;
}

/** The Original's stored log and the anchoring sat its head names. */
async function headOnSat(sdk: OriginalsSDK, did: string): Promise<StoredHead> {
  const { log } = readEvidence((await sdk.package(did)).bytes);
  const lines = log.trimEnd().split("\n");
  const line = lines[lines.length - 1];
  const entries = lines.map((l) => JSON.parse(l) as { versionId: string; state: { asset: { aliases: string[] } } });
  const head = entries[entries.length - 1];
  const alias = head.state.asset.aliases.find((a) => a.startsWith("did:btco:"));
  if (!alias) refuse("invalid-evidence", "NOT_ANCHORED", `${did} has no anchoring entry; anchor it first (P9.10)`);
  return { line, versionId: head.versionId, sat: parseBtcoAlias(alias), entries };
}

/** P9.13: the stored head must be the entry Bitcoin can accept next. */
function checkNext(stored: StoredHead, view: OriginalView): void {
  const ids = stored.entries.map((e) => e.versionId);
  const head = stored.versionId;
  if (view.report.anchoring?.status !== "anchored") {
    const anchor = ids[anchoringIndex(stored.entries)];
    if (anchor !== head) refuse("invalid-evidence", "HEAD_NOT_NEXT", `Bitcoin does not show the anchor yet: inscribe the anchoring entry ${anchor} before ${head}`);
    return;
  }
  const onChain = view.report.head;
  if (head === onChain) refuse("invalid-evidence", "HEAD_NOT_NEXT", `${head} is already inscribed on the anchoring sat`);
  if (ids[ids.length - 2] !== onChain) {
    refuse("invalid-evidence", "HEAD_NOT_NEXT", `${head} does not follow ${onChain ?? "nothing"}, the head Bitcoin shows; inscribe the entries between them first`);
  }
}

export type EntryInscriptionParams = Omit<InscribeOnSatParams, "buildContent" | "recoveryStore"> & {
  sdk: OriginalsSDK;
  did: string;
  /** Inscription times for reading the sat first, to check the head is next (P9.13). */
  clock: InscriptionClock;
  /** Which index serves that read (P9.11). */
  index: string;
};

export interface PreparedEntryInscription {
  /** The entry this pair inscribes: the stored head. */
  versionId: string;
  /** The anchoring sat, as its did:btco alias. */
  sat: string;
  prepared: PreparedInscriptionOnSat;
}

const NETWORK: Record<string, string> = { mainnet: "mainnet", signet: "signet", testnet: "testnet", regtest: "regtest" };

/** Build (not broadcast) the pair that inscribes the Original's head entry on its anchoring sat. */
export async function prepareEntryInscription(params: EntryInscriptionParams): Promise<PreparedEntryInscription> {
  const { sdk, did, clock, index, ...rest } = params;
  const head = await headOnSat(sdk, did);
  if (NETWORK[head.sat.network] !== params.network) {
    refuse("invalid-evidence", "NETWORK_MISMATCH", `${head.sat.did} is a ${head.sat.network} sat; the writer is on ${params.network}`);
  }
  checkNext(head, await readAnchored(sdk, did, { provider: params.provider, clock, index }));
  const content = new TextEncoder().encode(`${head.line}\n`);
  const prepared = await prepareInscriptionOnSat({
    ...rest,
    buildContent: (satoshi) => {
      if (satoshi !== head.sat.sat) {
        refuse("invalid-evidence", "WRONG_SAT", `the first funding UTXO holds sat ${satoshi}, not the anchoring sat ${head.sat.sat}`);
      }
      return Promise.resolve({ content, contentType: ORIGINALS_INSCRIPTION_TYPE });
    },
  });
  return { versionId: head.versionId, sat: head.sat.did, prepared };
}

export interface ReadAnchoredOptions {
  provider: Pick<OrdinalsProvider, "getSatSnapshot" | "getTransactionStatus">;
  clock: InscriptionClock;
  /** Which index serves the sat read, reported as used (P9.11; `satEvidence`). */
  index: string;
}

/** Read the anchoring sat and verify the Original against it (P9.12, P9.13). */
export async function readAnchored(sdk: OriginalsSDK, did: string, options: ReadAnchoredOptions): Promise<OriginalView> {
  const { sat } = await headOnSat(sdk, did);
  if (!options.provider.getSatSnapshot) refuse("incomplete-evidence", "SAT_SNAPSHOT_UNSUPPORTED", "the provider cannot read a complete sat");
  const snapshot = await options.provider.getSatSnapshot(sat.sat);
  if (snapshot.network !== NETWORK[sat.network] || snapshot.sat !== sat.sat) {
    refuse("invalid-evidence", "NETWORK_MISMATCH", `the provider read sat ${snapshot.sat} on ${snapshot.network}, not ${sat.did}`);
  }
  const satpoint = snapshot.ownership.satpoint;
  const ownerConfirmations = satpoint ? (await options.provider.getTransactionStatus(satpoint.split(":")[0])).confirmations ?? 0 : 0;
  const evidence = await satEvidence(snapshot, { clock: options.clock, ownerConfirmations, index: options.index });
  return sdk.get(did, { bitcoin: [evidence] });
}
