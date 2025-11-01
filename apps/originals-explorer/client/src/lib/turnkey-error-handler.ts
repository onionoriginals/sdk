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
 * Handles both Turnkey's structured error format and generic error messages
 */
export function isTokenExpiredError(error: unknown): boolean {
  if (!error) return false;

  // Try to parse JSON string errors (Turnkey SDK might serialize errors)
  let parsedError: unknown = error;
  if (typeof error === 'string') {
    try {
      parsedError = JSON.parse(error);
    } catch {
      // Not JSON, use original string
      parsedError = error;
    }
  }

  // Check if error is an Error object - try to extract data from message or other properties
  if (error instanceof Error) {
    // Try parsing error.message as JSON (Turnkey might serialize errors)
    try {
      const parsed = JSON.parse(error.message);
      if (typeof parsed === 'object' && parsed !== null) {
        parsedError = parsed;
      }
    } catch {
      // Not JSON, continue with normal checks
    }
    
    // Check for common error properties (Turnkey SDK might wrap errors)
    const errorAny = error as any;
    
    // Check common SDK error patterns
    if (errorAny.response?.data) {
      parsedError = errorAny.response.data;
    } else if (errorAny.data) {
      parsedError = errorAny.data;
    } else if (errorAny.body) {
      parsedError = errorAny.body;
    } else if (errorAny.error) {
      parsedError = errorAny.error;
    } else if (errorAny.details) {
      parsedError = errorAny.details;
    }
    
    // Check if the error itself has the structure (might be a plain object wrapped in Error)
    if (errorAny.turnkeyErrorCode || errorAny.code) {
      parsedError = errorAny;
    }
  }

  // Check for Turnkey's structured error format
  // Turnkey errors can have: { code, message, turnkeyErrorCode, details }
  if (typeof parsedError === 'object' && parsedError !== null) {
    const errorObj = parsedError as Record<string, unknown>;
    
    // Check for Turnkey-specific error codes
    if (errorObj.turnkeyErrorCode === 'API_KEY_EXPIRED' || 
        errorObj.turnkeyErrorCode === 'SESSION_EXPIRED' ||
        errorObj.turnkeyErrorCode === 'INVALID_SESSION') {
      return true;
    }
    
    // Check for error code 16 (API_KEY_EXPIRED) or other auth-related codes
    if (typeof errorObj.code === 'number' && 
        (errorObj.code === 16 || errorObj.code === 7 || errorObj.code === 8)) {
      return true;
    }
    
    // Check nested error objects (Turnkey SDK might wrap errors)
    if (errorObj.error && typeof errorObj.error === 'object') {
      const nestedError = errorObj.error as Record<string, unknown>;
      if (nestedError.turnkeyErrorCode === 'API_KEY_EXPIRED' ||
          nestedError.turnkeyErrorCode === 'SESSION_EXPIRED' ||
          nestedError.turnkeyErrorCode === 'INVALID_SESSION') {
        return true;
      }
      if (typeof nestedError.code === 'number' && nestedError.code === 16) {
        return true;
      }
    }
    
    // Check details array for Turnkey error codes
    if (Array.isArray(errorObj.details)) {
      const hasExpiredError = errorObj.details.some((detail: unknown) => {
        if (typeof detail === 'object' && detail !== null) {
          const detailObj = detail as Record<string, unknown>;
          return detailObj.turnkeyErrorCode === 'API_KEY_EXPIRED' ||
                 detailObj.turnkeyErrorCode === 'SESSION_EXPIRED' ||
                 detailObj.turnkeyErrorCode === 'INVALID_SESSION';
        }
        return false;
      });
      if (hasExpiredError) {
        return true;
      }
    }
  }

  // Check error message for expiration patterns
  let errorMessage = '';
  if (parsedError instanceof Error) {
    errorMessage = parsedError.message.toLowerCase();
  } else if (typeof parsedError === 'object' && parsedError !== null) {
    const errorObj = parsedError as Record<string, unknown>;
    // Try to extract message from various possible locations
    if (typeof errorObj.message === 'string') {
      errorMessage = errorObj.message.toLowerCase();
    } else if (typeof errorObj.error === 'string') {
      errorMessage = errorObj.error.toLowerCase();
    } else {
      errorMessage = String(parsedError).toLowerCase();
    }
  } else {
    errorMessage = String(parsedError).toLowerCase();
  }
  
  // Also check original error message if we parsed it
  if (error instanceof Error && error.message) {
    const originalMessage = error.message.toLowerCase();
    if (originalMessage !== errorMessage) {
      errorMessage = originalMessage + ' ' + errorMessage;
    }
  }
  
  // Check if error.toString() contains expiration info
  if (error instanceof Error) {
    const errorString = error.toString().toLowerCase();
    if (errorString.includes('expired') || errorString.includes('api_key_expired')) {
      return true;
    }
  }

  // Common patterns for expired/invalid token errors
  const expiredPatterns = [
    'expired api key',
    'api key expired',
    'expired api',
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
    'expired key',
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
    // Log the error for debugging
    console.log('Turnkey error caught:', error);
    console.log('Error type:', typeof error);
    console.log('Error instanceof Error:', error instanceof Error);
    if (error instanceof Error) {
      console.log('Error message:', error.message);
      console.log('Error stack:', error.stack);
    }
    if (typeof error === 'object' && error !== null) {
      console.log('Error object keys:', Object.keys(error));
      console.log('Error object:', JSON.stringify(error, null, 2));
    }
    
    // Deep check: recursively search for expiration indicators in the error
    const errorString = JSON.stringify(error);
    console.log('Error as JSON string:', errorString);
    
    // Check if this is a token expiration error
    const isExpired = isTokenExpiredError(error);
    console.log('Is token expired?', isExpired);
    
    // ALSO check the JSON string directly as a fallback
    const jsonStringCheck = errorString.toLowerCase().includes('api_key_expired') ||
                           errorString.toLowerCase().includes('expired api key') ||
                           errorString.toLowerCase().includes('"code":16') ||
                           errorString.toLowerCase().includes('turnkeyerrorcode":"api_key_expired');
    console.log('JSON string check for expiration:', jsonStringCheck);
    
    if (isExpired || jsonStringCheck) {
      console.warn('Turnkey session expired detected:', error);
      
      // Call the expiration handler if provided
      if (onExpired) {
        console.log('Calling onExpired callback');
        try {
          onExpired();
        } catch (callbackError) {
          console.error('Error in onExpired callback:', callbackError);
        }
      } else {
        console.warn('No onExpired callback provided');
      }
      
      // Throw a clean error that can be caught and handled by the UI
      throw new TurnkeySessionExpiredError(
        'Your Turnkey session has expired. Please log in again.'
      );
    }
    
    // Re-throw non-expiration errors as-is
    throw error;
  }
}
