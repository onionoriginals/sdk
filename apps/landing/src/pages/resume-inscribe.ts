/**
 * Picking a published Original back up and carrying it to Bitcoin.
 *
 * The Original is rebuilt from what it hosts — nothing about it survives in
 * this tab — and then handed to the SAME `engine.inscribe({ funding })` the
 * demo uses. That path is not forked or reimplemented here: this module only
 * gathers the inputs (the hosted CEL, the sealed bytes, the creator's funding
 * UTXOs) and calls it.
 */
import { webvhArtifacts, sameOriginUrl, type CelLog } from './original-detail-data';
import { hostedAssetEnvelope, hostedResourceRefs } from '../sdk/hosted-envelope';
import { selectFundingUtxos, inscribeIsComplete, type DepositInfo } from '../components/Demo';
import { ensureAuthorshipAccount, type TurnkeyBitcoinClient } from '../auth/turnkey-session';
import { authorshipPublicKeyMultibase, canAuthor } from '../sdk/turnkey-cel-signer';

/** Fetch an Original's hosted CEL. `null` when it cannot be read. */
export async function fetchHostedCel(did: string, host?: string): Promise<CelLog | null> {
  const artifacts = webvhArtifacts(did, host);
  if (!artifacts) return null;
  try {
    const res = await fetch(sameOriginUrl(artifacts.celUrl, host), { credentials: 'same-origin' });
    if (!res.ok) return null;
    return (await res.json()) as CelLog;
  } catch {
    return null;
  }
}

/**
 * Fetch the sealed bytes back, keyed by the segment each version is hosted
 * under. EVERY version, not just genesis: a revised Original that rebuilt from
 * its v1 bytes alone would anchor superseded artwork to Bitcoin.
 *
 * A version that will not load is simply absent, which `hostedAssetEnvelope`
 * reports as MISSING_CONTENT rather than papering over.
 */
export async function fetchHostedResources(
  did: string,
  cel: CelLog | null,
  host?: string
): Promise<Record<string, string>> {
  const artifacts = webvhArtifacts(did, host);
  const contents: Record<string, string> = {};
  if (!artifacts) return contents;
  await Promise.all(
    hostedResourceRefs(cel).map(async (ref) => {
      if (!ref.segment) return;
      try {
        const res = await fetch(sameOriginUrl(artifacts.resourceUrl(ref.segment), host), {
          credentials: 'same-origin',
        });
        if (res.ok) contents[ref.segment] = await res.text();
      } catch {
        /* absent → MISSING_CONTENT, reported by the envelope builder */
      }
    })
  );
  return contents;
}

/**
 * The viewer's authorship `did:key` — the identity an Original they can still
 * author names as its controller. Null when this session cannot produce one,
 * which is what disables the action rather than letting it fail at signing
 * time.
 */
export async function resolveAuthorshipDid(
  client: TurnkeyBitcoinClient | null | undefined,
  subOrgId: string | undefined
): Promise<string | null> {
  if (!client || !subOrgId || !canAuthor(client)) return null;
  try {
    const address = await ensureAuthorshipAccount(client, subOrgId);
    const multibase = authorshipPublicKeyMultibase(address);
    return multibase ? `did:key:${multibase}` : null;
  } catch {
    return null;
  }
}

export type ResumeOutcome =
  | {
      ok: true;
      inscription: { commitTxId?: string; txid?: string; satoshi?: string };
      /**
       * FALSE when only the commit reached the network. The reveal carries the
       * inscription, so until it propagates there is nothing on chain to point
       * at — and #506 fixed exactly this lie in the demo. The resume path
       * repeated it: any inscription snapshot read as done.
       */
      complete: boolean;
    }
  | { ok: false; message: string };

/**
 * Rebuild `did` from its hosted artifacts and inscribe it.
 *
 * `deposit` is read through the app's existing GET /api/btc/deposit — the one
 * source of truth for the creator's spendable UTXOs and the fee target. This
 * module neither estimates fees nor selects UTXOs by its own rules; it reuses
 * `selectFundingUtxos`, the same selection the demo funds from.
 */
export async function resumeInscribe(opts: {
  did: string;
  host?: string;
  subOrgId?: string;
  fundingAddress: string;
  signingClient: TurnkeyBitcoinClient;
  /** Already-fetched CEL, when the page has one (the detail page does). */
  cel?: CelLog | null;
  /** Injectable for tests; defaults to the real endpoint. */
  loadDeposit?: (address: string) => Promise<DepositInfo | null>;
  onProgress?: (stage: 'hydrating' | 'inscribing') => void;
}): Promise<ResumeOutcome> {
  const { did, host, subOrgId, fundingAddress, signingClient, onProgress } = opts;
  try {
    onProgress?.('hydrating');
    const cel = opts.cel ?? (await fetchHostedCel(did, host));
    const contents = await fetchHostedResources(did, cel, host);
    const built = hostedAssetEnvelope(cel, contents);
    if ('problem' in built) return { ok: false, message: built.problem.message };

    const loadDeposit =
      opts.loadDeposit ??
      (async (address: string) => {
        const res = await fetch(`/api/btc/deposit?address=${encodeURIComponent(address)}`, {
          credentials: 'same-origin',
        });
        return res.ok ? ((await res.json()) as DepositInfo) : null;
      });
    const deposit = await loadDeposit(fundingAddress);
    if (!deposit) {
      return { ok: false, message: 'Could not read your deposit address, so nothing was built or spent.' };
    }
    const selection = selectFundingUtxos(deposit.confirmedUtxos, deposit.estimatedCostSats);
    // `shortfallSats` is how far the WHOLE spendable balance falls short, and
    // is 0 exactly when the deposit covers the quote. Refuse here rather than
    // building a commit that cannot pay for itself.
    if (selection.shortfallSats > 0 || selection.selected.length === 0) {
      return {
        ok: false,
        message: 'Your deposit does not cover this inscription yet — top it up and try again.',
      };
    }

    const { DemoEngine } = await import('../sdk/engine');
    const engine = new DemoEngine({ authed: true, subOrgId });
    await engine.hydrate(built.envelope);

    onProgress?.('inscribing');
    // The existing path, unchanged.
    const state = await engine.inscribe({
      funding: { fundingUtxos: selection.selected, changeAddress: fundingAddress, signingClient },
    });
    if (!state.inscription) return { ok: false, message: 'The inscription did not complete.' };

    // What actually reached the network. The SDK discards submitInscription's
    // return, so the browser reads it back off the provider — the same seam
    // the demo's completion panel reads. A status we cannot read means the
    // reveal is NOT known to have landed, so nothing is claimed.
    const submitted = (engine.ordinalsProvider as { lastSubmit?: { status?: string } }).lastSubmit;
    return {
      ok: true,
      inscription: state.inscription,
      complete: inscribeIsComplete(submitted?.status),
    };
  } catch (err) {
    return { ok: false, message: (err as Error)?.message ?? 'Could not inscribe this Original.' };
  }
}
