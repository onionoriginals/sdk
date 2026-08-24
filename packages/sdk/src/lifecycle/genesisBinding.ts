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
import type { EventLog } from '@originals/cel';
import { hexSha256ToDigestMultibase } from '@originals/cel';

export function checkGenesisResourceBinding(log: EventLog, resources: AssetResource[]): boolean {
  const genesis = log.events[0]?.data as { resources?: unknown; did?: unknown } | undefined;
  const genesisResources = genesis?.resources;
  if (!Array.isArray(genesisResources)) {
    // Controller-shaped genesis MUST carry a resources array; a missing/
    // malformed one fails closed. Only legacy-shaped geneses (data.did) —
    // which predate this contract — skip the check.
    return typeof genesis?.did === 'string';
  }
  // Total by construction: a resource whose hash is not a sha256 hex string
  // cannot match any genesis digest, and `hexSha256ToDigestMultibase` THROWS on
  // one. Letting that escape turned a plain "these resources don't back this
  // log" into an exception — swallowed as a bare `false` by verify()'s catch,
  // and escaping loadAsset as a raw error instead of its structured
  // ASSET_LOAD_VERIFICATION_FAILED. A malformed hash is simply not a match.
  const present = new Set<string>();
  for (const r of resources) {
    try {
      present.add(hexSha256ToDigestMultibase(r.hash));
    } catch {
      // Not a usable digest — contributes nothing to the present set.
    }
  }
  for (const entry of genesisResources) {
    const dm = (entry as { digestMultibase?: unknown })?.digestMultibase;
    if (typeof dm !== 'string' || !present.has(dm)) {
      return false;
    }
  }
  return true;
}
