/**
 * Resource↔genesis binding check (#377). Extracted from
 * OriginalsAsset.runVerificationChecks so both the live verify path and
 * loadAsset share ONE definition of "these resources back this log's genesis".
 *
 * Direction is subset (genesis ⊆ current): every resource digest recorded at
 * genesis must still be present among the supplied resources. addResourceVersion
 * may add MORE, but a genesis entry may never go MISSING — otherwise an asset
 * holding the genuine log but swapped resources would pass verification the
 * resources do not actually back.
 */
import type { AssetResource } from '../types/index.js';
import type { EventLog } from '../cel/types.js';
import { hexSha256ToDigestMultibase } from '../cel/signerAdapter.js';

export function checkGenesisResourceBinding(log: EventLog, resources: AssetResource[]): boolean {
  const genesis = log.events[0]?.data as { resources?: unknown; did?: unknown } | undefined;
  const genesisResources = genesis?.resources;
  if (!Array.isArray(genesisResources)) {
    // Controller-shaped genesis MUST carry a resources array; a missing/
    // malformed one fails closed. Only legacy-shaped geneses (data.did) —
    // which predate this contract — skip the check.
    return typeof genesis?.did === 'string';
  }
  const present = new Set(resources.map(r => hexSha256ToDigestMultibase(r.hash)));
  for (const entry of genesisResources) {
    const dm = (entry as { digestMultibase?: unknown })?.digestMultibase;
    if (typeof dm !== 'string' || !present.has(dm)) {
      return false;
    }
  }
  return true;
}
