/**
 * Shared types for @originals/auth
 */

/**
 * Authenticated user information
 */
export interface AuthUser {
  /** Database user ID */
  id: string;
  /** User's email address */
  email: string;
  /** User's DID identifier */
  did: string;
  /** Turnkey sub-organization ID */
  turnkeySubOrgId: string;
}

/**
 * JWT token payload structure
 */
export interface TokenPayload {
  /** Subject - Turnkey sub-organization ID (stable identifier) */
  sub: string;
  /** User email (metadata) */
  email: string;
  /** Optional Turnkey session token for user authentication */
  sessionToken?: string;
  /** Issued at timestamp */
  iat: number;
  /** Expiration timestamp */
  exp: number;
}

/**
 * Options for creating auth middleware
 */
export interface AuthMiddlewareOptions {
  /** Function to look up user by Turnkey sub-org ID */
  getUserByTurnkeyId: (turnkeyId: string) => Promise<AuthUser | null>;
  /** Optional function to create user on first auth */
  createUser?: (turnkeyId: string, email: string, temporaryDid: string) => Promise<AuthUser>;
  /** Cookie name for JWT token (default: 'auth_token') */
  cookieName?: string;
  /** JWT secret (default: process.env.JWT_SECRET) */
  jwtSecret?: string;
}

/**
 * Email authentication session
 */
export interface EmailAuthSession {
  /** User's email address */
  email: string;
  /** Turnkey sub-organization ID */
  subOrgId?: string;
  /** Turnkey OTP ID */
  otpId?: string;
  /** Session creation timestamp */
  timestamp: number;
  /** Whether the session has been verified */
  verified: boolean;
}

/**
 * Result of initiating email authentication
 */
export interface InitiateAuthResult {
  /** Session ID for verification step */
  sessionId: string;
  /** User-friendly message */
  message: string;
}

/**
 * Result of verifying email authentication
 */
export interface VerifyAuthResult {
  /** Whether verification was successful */
  verified: boolean;
  /** User's email address */
  email: string;
  /** Turnkey sub-organization ID */
  subOrgId: string;
}

/**
 * Cookie configuration for auth tokens
 */
export interface AuthCookieConfig {
  /** Cookie name */
  name: string;
  /** Cookie value (JWT token) */
  value: string;
  /** Cookie options */
  options: {
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'strict' | 'lax' | 'none';
    maxAge: number;
    path: string;
  };
}

/**
 * Turnkey wallet information
 */
export interface TurnkeyWallet {
  /** Wallet ID */
  walletId: string;
  /** Wallet name */
  walletName: string;
  /** Wallet accounts */
  accounts: TurnkeyWalletAccount[];
}

/**
 * Turnkey wallet account
 */
export interface TurnkeyWalletAccount {
  /** Account address */
  address: string;
  /** Cryptographic curve */
  curve: 'CURVE_SECP256K1' | 'CURVE_ED25519';
  /** Derivation path */
  path: string;
  /** Address format */
  addressFormat: string;
}

/**
 * Client-side Turnkey authentication state
 */
export interface TurnkeyAuthState {
  /** Whether the user is authenticated */
  isAuthenticated: boolean;
  /** Whether an auth operation is in progress */
  isLoading: boolean;
  /** Error message if any */
  error: string | null;
  /** User's email address */
  email: string | null;
  /** User's wallets */
  wallets: TurnkeyWallet[];
  /** OTP ID for verification step */
  otpId: string | null;
}

/**
 * Request context with authenticated user
 */
export interface AuthenticatedRequest {
  user: {
    /** Database user ID */
    id: string;
    /** Turnkey sub-organization ID */
    turnkeySubOrgId: string;
    /** User's email */
    email: string;
    /** User's DID */
    did: string;
    /** Turnkey session token (if available) */
    sessionToken?: string;
  };
}



