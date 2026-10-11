import {
  OriginalsSDK,
  createLocalSigner,
  type LoadedAsset,
} from "@originals/sdk";

/**
 * A self-contained local example for the SDK in this checkout.
 *
 * This disposable key exists only in memory. For real assets, supply a key from
 * your own custody and retain it for later edits. Never commit or log private keys.
 */
export async function basicExample(): Promise<LoadedAsset> {
  const secretKeyBytes = crypto.getRandomValues(new Uint8Array(32));
  const signer = createLocalSigner("Ed25519", secretKeyBytes);
  const sdk = OriginalsSDK.create({ signer });
  const asset = await sdk.lifecycle.createAsset(
    [{ id: "greeting", mediaType: "text/plain", content: "Hello, Originals!" }],
    { name: "First greeting" },
  );

  // The SDK queues mutations and computes digests from the actual resource bytes.
  await Promise.all([
    asset.update({ name: "Revised greeting" }),
    asset.addResourceVersion(
      "greeting",
      "Hello again, Originals!",
      "text/plain",
    ),
  ]);

  // The envelope retains both historical resource versions. Reading and checking
  // them in a fresh SDK does not require the controller's private key.
  const saved = JSON.stringify(asset.serialize());
  return OriginalsSDK.create().lifecycle.loadAsset(saved);
}
