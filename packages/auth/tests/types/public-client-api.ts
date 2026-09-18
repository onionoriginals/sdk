// Compile against the installed @originals/auth export map, independently of
// the package's own src tsconfig. Mirrors
// packages/sdk/tests/types/public-cel3.ts: exercises the exact positional
// signatures specs/auth/client-api.md documents, so a signature change that
// silently breaks a documented example fails this compile step instead of
// only being caught by prose review (#716's own recommended next step).
import type { Turnkey } from "@turnkey/sdk-server";
import {
  initOtp,
  completeOtp,
  fetchUser,
  fetchWallets,
  createWalletWithAccounts,
  ensureWalletWithAccounts,
  getKeyByRole,
  sendOtp,
  verifyOtp,
  type InitOtpResult,
  type CompleteOtpResult,
} from "@originals/auth/client";
import type { TurnkeyWallet } from "@originals/auth/types";

declare const turnkeyClient: Turnkey;
declare const subOrgId: string;
declare const onExpired: () => void;

// initOtp(turnkeyClient, email, subOrgId?)
const initResult: InitOtpResult = await initOtp(turnkeyClient, "user@example.com");
const initResultScoped: InitOtpResult = await initOtp(turnkeyClient, "user@example.com", subOrgId);
void initResultScoped;

// completeOtp(turnkeyClient, otpId, otpCode, subOrgId, otpEncryptionTargetBundle, options?)
const completeResult: CompleteOtpResult = await completeOtp(
  turnkeyClient,
  initResult.otpId,
  "123456",
  subOrgId,
  initResult.otpEncryptionTargetBundle,
  { publicKey: "02" + "ab".repeat(32) },
);
void completeResult;

// fetchUser(turnkeyClient, subOrgId, onExpired?) — NOT (turnkeyClient, onExpired?)
const user: unknown = await fetchUser(turnkeyClient, subOrgId, onExpired);
void user;

// fetchWallets(turnkeyClient, subOrgId, onExpired?)
const wallets: TurnkeyWallet[] = await fetchWallets(turnkeyClient, subOrgId, onExpired);
void wallets;

// createWalletWithAccounts(turnkeyClient, subOrgId, onExpired?)
const wallet: TurnkeyWallet = await createWalletWithAccounts(turnkeyClient, subOrgId, onExpired);
void wallet;

// ensureWalletWithAccounts(turnkeyClient, subOrgId, onExpired?)
const ensured: TurnkeyWallet[] = await ensureWalletWithAccounts(turnkeyClient, subOrgId, onExpired);
const bitcoinAuthKey = getKeyByRole(ensured, "bitcoin-auth");
void bitcoinAuthKey;

// sendOtp(email, endpoint?, options?)
const sendResult = await sendOtp("user@example.com");
void sendResult;

// verifyOtp(sessionId, code, endpoint?, options?)
const verifyResult = await verifyOtp("session-id", "123456", undefined, { publicKey: "02" + "cd".repeat(32) });
void verifyResult;

// The stale, previously-documented shape must NOT type-check: #716 found an
// `onExpired` callback silently bound into the `subOrgId` slot because the
// docs omitted the required `subOrgId` parameter. If any of these four
// functions regains a 2-argument (client, onExpired?) overload, one of these
// calls starts compiling and this file stops guarding against that drift.
// @ts-expect-error fetchUser requires subOrgId; (client, onExpired) must not compile.
fetchUser(turnkeyClient, onExpired);
// @ts-expect-error fetchWallets requires subOrgId; (client, onExpired) must not compile.
fetchWallets(turnkeyClient, onExpired);
// @ts-expect-error createWalletWithAccounts requires subOrgId; (client, onExpired) must not compile.
createWalletWithAccounts(turnkeyClient, onExpired);
// @ts-expect-error ensureWalletWithAccounts requires subOrgId; (client, onExpired) must not compile.
ensureWalletWithAccounts(turnkeyClient, onExpired);
