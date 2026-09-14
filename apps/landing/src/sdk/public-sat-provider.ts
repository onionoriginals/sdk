/**
 * Read-only Bitcoin access for the PUBLIC Explore cold-start verifier
 * (`/explore/<did>`) — a signed-out visitor with no account, no local state
 * and no Originals session cookie. Hits `/api/explore/sat-snapshot/:sat`
 * (unauthenticated, independently rate-limited — see server/explore.ts)
 * rather than the authenticated money-path proxy at `/api/btc/sat-snapshot/:sat`
 * that `HttpOrdinalsProvider` uses, which 401s without a session.
 *
 * `sdk.lifecycle.resolveAssetFromSat` only ever calls `getSatSnapshot` on the
 * `OrdinalsProvider` it is given — mirrors HttpOrdinalsProvider's contract:
 * every other method rejects by design, so a mislabeled call can never
 * silently fund, sign or broadcast anything from this public page.
 */
import type { SatSnapshot } from "@originals/sdk/cel";
import type { OrdinalsProvider } from "@originals/sdk";
import { decodeSatSnapshot } from "./http-ordinals-provider";

export class PublicSatSnapshotProvider implements OrdinalsProvider {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts?: { baseUrl?: string; fetchImpl?: typeof fetch }) {
    this.baseUrl = opts?.baseUrl ?? "";
    this.fetchImpl = opts?.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async getSatSnapshot(sat: string): Promise<SatSnapshot> {
    if (!/^(0|[1-9][0-9]*)$/.test(sat))
      throw new Error("Invalid satoshi number");
    const response = await this.fetchImpl(
      `${this.baseUrl}/api/explore/sat-snapshot/${sat}`,
    );
    if (!response.ok)
      throw new Error(`Sat snapshot unavailable: ${response.status}`);
    return decodeSatSnapshot(await response.json());
  }

  // --- Not implemented: the public Explore verifier only ever reads a sat
  // snapshot. Rejecting everything else keeps this class from ever being
  // mistaken for a provider capable of funding, signing or broadcasting. ---
  getInscriptionById(): Promise<never> {
    return Promise.reject(
      new Error(
        "PublicSatSnapshotProvider.getInscriptionById is not implemented: this is a read-only public verification provider.",
      ),
    );
  }
  getInscriptionsBySatoshi(): Promise<never> {
    return Promise.reject(
      new Error(
        "PublicSatSnapshotProvider.getInscriptionsBySatoshi is not implemented: this is a read-only public verification provider.",
      ),
    );
  }
  getTransactionStatus(): Promise<never> {
    return Promise.reject(
      new Error(
        "PublicSatSnapshotProvider.getTransactionStatus is not implemented: this is a read-only public verification provider.",
      ),
    );
  }
  estimateFee(): Promise<never> {
    return Promise.reject(
      new Error(
        "PublicSatSnapshotProvider.estimateFee is not implemented: this is a read-only public verification provider.",
      ),
    );
  }
  createInscription(): Promise<never> {
    return Promise.reject(
      new Error(
        "PublicSatSnapshotProvider.createInscription is not implemented: this is a read-only public verification provider.",
      ),
    );
  }
  transferInscription(): Promise<never> {
    return Promise.reject(
      new Error(
        "PublicSatSnapshotProvider.transferInscription is not implemented: this is a read-only public verification provider.",
      ),
    );
  }
  broadcastTransaction(): Promise<never> {
    return Promise.reject(
      new Error(
        "PublicSatSnapshotProvider.broadcastTransaction is not implemented: this is a read-only public verification provider.",
      ),
    );
  }
}
