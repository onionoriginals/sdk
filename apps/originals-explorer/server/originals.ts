import { OriginalsSDK } from "@originals/sdk";

export const originalsSdk = OriginalsSDK.create({
  network: process.env.ORIGINALS_NETWORK as "mainnet" | "testnet" | "regtest" || "mainnet",
  enableLogging:
    process.env.ORIGINALS_SDK_LOG === "1" ||
    process.env.ORIGINALS_SDK_LOG === "true",
});

