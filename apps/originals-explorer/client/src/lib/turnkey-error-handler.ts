/**
 * Turnkey Error Handler
 * Detects and handles Turnkey API errors, especially token expiration
 */

export class TurnkeySessionExpiredError extends Error {
  constructor(message = 'Turnkey session has expired') {
    super(message);
    this.name = 'TurnkeySessionExpiredError';
  }
}

/**
 * Check if an error indicates an expired or invalid session token
 */
export function isTokenExpiredError(error: unknown): boolean {
  if (!error) return false;

  const errorMessage = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

  // Common patterns for expired/invalid token errors
  const expiredPatterns = [
    'unauthorized',
    'invalid session',
    'session expired',
    'token expired',
    'invalid token',
    'authentication failed',
    '401',
    '403',
    'not authenticated',
    'session not found',
  ];

  return expiredPatterns.some(pattern => errorMessage.includes(pattern));
}

/**
 * Wrap a Turnkey API call with automatic token expiration detection
 */
export async function withTokenExpiration<T>(
  operation: () => Promise<T>,
  onExpired?: () => void
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isTokenExpiredError(error)) {
      // Call the expiration handler if provided
      if (onExpired) {
        onExpired();
      }
      throw new TurnkeySessionExpiredError();
    }
    // Re-throw non-expiration errors
    throw error;
  }
}
