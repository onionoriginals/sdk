import type { Request, Response, NextFunction } from "express";
import { PrivyClient } from "@privy-io/server-auth";
import { storage } from "./storage";
import { 
  isDidWebVHEnabled, 
  isDualReadEnabled, 
  verifyDIDWebVH,
  auditLog 
} from "./didwebvh-service";

/**
 * Extended request interface with user information
 */
export interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    privyDid: string;
    did_webvh?: string | null;
    did_privy?: string | null;
    canonicalDid: string; // The canonical DID to use (did:webvh when enabled, did:privy otherwise)
  };
  correlationId: string;
}

/**
 * Token payload interface
 */
interface TokenPayload {
  sub: string; // Subject - can be did:webvh or did:privy depending on flag
  legacy_sub?: string; // Optional legacy subject for backward compatibility
  ver?: string; // Version identifier
  userId: string; // Privy user ID
}

/**
 * Create enhanced authentication middleware with DID:WebVH support
 * Supports dual-read mode during migration
 * @param privyClient - Initialized Privy client
 * @returns Express middleware function
 */
export function createAuthMiddleware(privyClient: PrivyClient) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const correlationId = req.headers['x-correlation-id'] as string || crypto.randomUUID();
    const startTime = Date.now();

    try {
      const authorizationHeader = req.headers.authorization;
      
      if (!authorizationHeader) {
        auditLog('auth.missing_header', { 
          path: req.path,
          correlationId 
        });
        return res.status(401).json({ error: "Missing authorization header" });
      }

      if (!authorizationHeader.startsWith('Bearer ')) {
        auditLog('auth.invalid_header_format', { 
          path: req.path,
          correlationId 
        });
        return res.status(401).json({ error: "Invalid authorization header format" });
      }

      const token = authorizationHeader.substring(7);
      
      // Verify token with Privy
      const verifiedClaims = await privyClient.verifyAuthToken(token);
      const privyUserId = verifiedClaims.userId;

      // Check if DID:WebVH migration is enabled
      const webvhEnabled = isDidWebVHEnabled();
      const dualReadEnabled = isDualReadEnabled();

      // Fetch user record to get DID information
      const user = await storage.getUser(privyUserId);
      
      if (!user) {
        auditLog('auth.user_not_found', { 
          privyUserId,
          correlationId 
        });
        return res.status(401).json({ error: "User not found" });
      }

      // Determine canonical DID based on feature flags
      let canonicalDid: string;
      let didSource: 'webvh' | 'privy' | 'fallback';

      if (webvhEnabled && user.did_webvh) {
        // DID:WebVH is enabled and user has a did:webvh - use it
        canonicalDid = user.did_webvh;
        didSource = 'webvh';

        // Verify the DID:WebVH (async verification with timeout)
        const verificationPromise = verifyDIDWebVH(user.did_webvh);
        const timeoutPromise = new Promise<{ valid: boolean; error?: string }>((resolve) => 
          setTimeout(() => resolve({ valid: false, error: 'Verification timeout' }), 5000)
        );
        
        const verification = await Promise.race([verificationPromise, timeoutPromise]);
        
        if (!verification.valid) {
          auditLog('auth.didwebvh_verification_failed', {
            did: user.did_webvh,
            error: verification.error,
            correlationId
          });
          
          // If verification fails and dual-read is disabled, reject
          if (!dualReadEnabled || !user.did_privy) {
            return res.status(401).json({ 
              error: "DID verification failed",
              details: verification.error 
            });
          }
          
          // Fall back to did:privy in dual-read mode
          canonicalDid = user.did_privy;
          didSource = 'privy';
          
          auditLog('auth.fallback_to_privy', {
            originalDid: user.did_webvh,
            fallbackDid: user.did_privy,
            reason: verification.error,
            correlationId
          });
        }
      } else if (dualReadEnabled && user.did_privy) {
        // Dual-read mode: accept did:privy
        canonicalDid = user.did_privy;
        didSource = 'privy';
      } else {
        // Fallback to Privy user ID
        canonicalDid = privyUserId;
        didSource = 'fallback';
        
        auditLog('auth.using_fallback_identifier', {
          privyUserId,
          webvhEnabled,
          dualReadEnabled,
          hasWebvh: !!user.did_webvh,
          hasPrivy: !!user.did_privy,
          correlationId
        });
      }

      // Add user info to request
      (req as any).user = {
        id: user.id,
        privyDid: privyUserId,
        did_webvh: user.did_webvh,
        did_privy: user.did_privy,
        canonicalDid,
      };
      (req as any).correlationId = correlationId;

      // Emit metrics
      const latency = Date.now() - startTime;
      emitMetric('auth.verify.latency', latency, { 
        source: didSource,
        webvhEnabled: String(webvhEnabled),
        dualReadEnabled: String(dualReadEnabled)
      });
      emitMetric('auth.verify.success', 1, { source: didSource });

      auditLog('auth.success', {
        userId: user.id,
        canonicalDid,
        didSource,
        latency,
        correlationId
      });

      next();
    } catch (error) {
      const latency = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      emitMetric('auth.verify.latency', latency, { error: 'true' });
      emitMetric('auth.verify.error', 1, { error: errorMessage });

      auditLog('auth.error', {
        error: errorMessage,
        latency,
        correlationId
      });

      console.error("Authentication error:", error);
      return res.status(401).json({ error: "Invalid or expired token" });
    }
  };
}

/**
 * Emit a metric (placeholder - integrate with your observability system)
 */
function emitMetric(name: string, value: number, tags?: Record<string, string>): void {
  if (process.env.NODE_ENV === 'development') {
    console.log(`[METRIC] ${name}=${value}`, tags || '');
  }
}
