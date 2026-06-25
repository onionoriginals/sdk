import { StructuredError } from '../utils/telemetry.js';

/**
 * Validate a domain string and return its normalized (trimmed, lowercased) form.
 *
 * Accepts hostnames (e.g. `example.com`), `localhost`, and IPv4 addresses, each
 * optionally followed by a single `:port`. Rejects empty/non-string input,
 * strings containing more than one colon, out-of-range ports, and malformed
 * hostnames.
 *
 * The normalized return value MUST be used for any subsequent encoding/DID
 * construction so that validation and the value actually used cannot diverge
 * (a domain with surrounding whitespace or mixed case otherwise passes
 * validation but produces a DID built from the un-normalized string).
 *
 * @param domain Raw domain string supplied by the caller.
 * @returns The normalized domain (trimmed + lowercased).
 * @throws StructuredError('INVALID_DOMAIN') when the domain is malformed.
 */
export function validateAndNormalizeDomain(domain: string): string {
  if (!domain || typeof domain !== 'string') {
    throw new StructuredError('INVALID_DOMAIN', 'Invalid domain: must be a non-empty string');
  }

  const normalized = domain.trim().toLowerCase();

  // Reject more than one colon up front: `split(':')` would otherwise silently
  // discard everything after the second segment, letting `example.com:8080:path`
  // pass validation while being handed to encodeURIComponent verbatim.
  const colonParts = normalized.split(':');
  if (colonParts.length > 2) {
    throw new StructuredError(
      'INVALID_DOMAIN',
      `Invalid domain format: ${domain}. Must be a valid hostname with at most one port (e.g., example.com or example.com:8080).`
    );
  }

  const [domainPart, portPart] = colonParts;

  // `portPart !== undefined` means a colon was present, so a port is required.
  // An empty string (trailing colon, e.g. `example.com:`) must be rejected, not
  // skipped as falsy — otherwise it would encode to a DID like
  // `did:webvh:example.com%3A:user`.
  if (portPart !== undefined && (portPart === '' || !/^\d+$/.test(portPart) || parseInt(portPart) < 1 || parseInt(portPart) > 65535)) {
    throw new StructuredError('INVALID_DOMAIN', `Invalid domain format: ${domain} - invalid port`);
  }

  // Allow localhost and IP addresses for development.
  const isLocalhost = domainPart === 'localhost';
  const isIP = /^(\d{1,3}\.){3}\d{1,3}$/.test(domainPart);

  if (!isLocalhost && !isIP) {
    const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
    const domainRegex = new RegExp(`^(?=.{1,253}$)(?:${label})(?:\\.(?:${label}))+?$`, 'i');
    if (!domainRegex.test(domainPart)) {
      throw new StructuredError(
        'INVALID_DOMAIN',
        `Invalid domain format: ${domain}. Must be a valid hostname (e.g., example.com) or localhost.`
      );
    }
  }

  return normalized;
}
