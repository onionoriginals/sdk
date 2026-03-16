/**
 * Canonical resource versioning types.
 *
 * This is the single source of truth for resource version metadata and history.
 * Both the resources module (ResourceManager) and lifecycle module (ResourceVersioning)
 * MUST import from here instead of defining their own copies.
 */

/**
 * Lightweight metadata for a single resource version.
 * Used by the ResourceVersionManager for tracking version chains.
 */
export interface ResourceVersion {
  /** Version number (1-indexed) */
  version: number;
  /** Unique content hash */
  hash: string;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** MIME content type */
  contentType: string;
  /** Optional description of changes in this version */
  changes?: string;
  /** Hash of the previous version (omitted for v1) */
  previousVersionHash?: string;
}

/**
 * Generic version history for a resource.
 * The version entry type defaults to ResourceVersion but can be
 * a richer type (e.g., Resource) when full content is available.
 */
export interface ResourceVersionHistory<V = ResourceVersion> {
  /** Logical resource ID (stable across all versions) */
  resourceId: string;
  /** All versions in chronological order (oldest first) */
  versions: V[];
  /** The current (latest) version */
  currentVersion: V;
  /** Total number of versions */
  versionCount: number;
}
