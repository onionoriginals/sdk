import { OriginalsSDK } from "@originals/sdk";

export const originalsSdk = OriginalsSDK.create({
  network: process.env.ORIGINALS_NETWORK as "mainnet" | "testnet" | "regtest" || "mainnet",
  enableLogging:
    process.env.ORIGINALS_SDK_LOG === "1" ||
    process.env.ORIGINALS_SDK_LOG === "true",
});

/**
 * Get SDK instance for a specific user (for now, returns shared instance)
 * In the future, this could return user-specific SDK instances with custom config
 */
export async function getOriginalsSDK(userId: string): Promise<OriginalsSDK> {
  // For now, return the shared SDK instance
  // In the future, we could create per-user SDK instances if needed
  return originalsSdk;
}

