/**
 * ResourceVersioning module for immutable resource versioning with verifiable provenance.
 * 
 * Resources in the Originals SDK are immutable and content-addressed. "Versioning" means
 * creating a new immutable resource instance with a new hash and linking it to the prior
 * version via previousVersionHash. Old versions remain accessible.
 */

export interface ResourceVersion {
  version: number;
  hash: string;               // Unique content hash
  timestamp: string;          // ISO timestamp
  contentType: string;
  changes?: string;           // Optional change description
  previousVersionHash?: string;
}

export interface ResourceHistory {
  resourceId: string;         // Logical ID (same across versions)
  versions: ResourceVersion[];
  currentVersion: ResourceVersion;
}

/**
 * ResourceVersionManager manages the versioning of immutable resources.
 * Each version is a separate resource with a unique content hash, linked to
 * its predecessor via previousVersionHash.
 */
export class ResourceVersionManager {
  private versionMap: Map<string, ResourceVersion[]>;

  constructor() {
    this.versionMap = new Map();
  }

  /**
   * Add a new version for a resource
   * @param resourceId - Logical resource ID (stable across versions)
   * @param hash - Content hash of the new version
   * @param contentType - Content type of the resource
   * @param previousVersionHash - Hash of the previous version (optional for v1)
   * @param changes - Optional description of changes
   */
  addVersion(
    resourceId: string,
    hash: string,
    contentType: string,
    previousVersionHash?: string,
    changes?: string
  ): void {
    const versions = this.versionMap.get(resourceId) || [];
    
    const version: ResourceVersion = {
      version: versions.length + 1,
      hash,
      timestamp: new Date().toISOString(),
      contentType,
      changes,
      previousVersionHash
    };
    
    versions.push(version);
    this.versionMap.set(resourceId, versions);
  }

  /**
   * Get the complete version history for a resource
   * @param resourceId - Logical resource ID
   * @returns ResourceHistory or null if resource doesn't exist
   */
  getHistory(resourceId: string): ResourceHistory | null {
    const versions = this.versionMap.get(resourceId);
    if (!versions || versions.length === 0) {
      return null;
    }

    return {
      resourceId,
      versions: [...versions],
      currentVersion: versions[versions.length - 1]
    };
  }

  /**
   * Get a specific version of a resource
   * @param resourceId - Logical resource ID
   * @param version - Version number (1-indexed)
   * @returns ResourceVersion or null if not found
   */
  getVersion(resourceId: string, version: number): ResourceVersion | null {
    const versions = this.versionMap.get(resourceId);
    if (!versions || version < 1 || version > versions.length) {
      return null;
    }
    return versions[version - 1];
  }

  /**
   * Get the current (latest) version of a resource
   * @param resourceId - Logical resource ID
   * @returns ResourceVersion or null if not found
   */
  getCurrentVersion(resourceId: string): ResourceVersion | null {
    const versions = this.versionMap.get(resourceId);
    if (!versions || versions.length === 0) {
      return null;
    }
    return versions[versions.length - 1];
  }

  /**
   * Verify the integrity of the version chain for a resource.
   * Ensures that:
   * - Version numbers are sequential starting at 1
   * - Each version (except v1) has a previousVersionHash
   * - Each previousVersionHash matches the actual previous version's hash
   * 
   * @param resourceId - Logical resource ID
   * @returns true if the chain is valid, false otherwise
   */
  verifyChain(resourceId: string): boolean {
    const versions = this.versionMap.get(resourceId);
    if (!versions || versions.length === 0) {
      return false;
    }

    for (let i = 0; i < versions.length; i++) {
      const version = versions[i];
      
      // Check version number is sequential
      if (version.version !== i + 1) {
        return false;
      }

      // First version should not have previousVersionHash
      if (i === 0) {
        if (version.previousVersionHash !== undefined) {
          return false;
        }
      } else {
        // Subsequent versions must have previousVersionHash matching the prior version
        const prevVersion = versions[i - 1];
        if (version.previousVersionHash !== prevVersion.hash) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Serialize the version manager state to JSON
   * @returns Object representation of all version data
   */
  toJSON(): object {
    const result: Record<string, ResourceVersion[]> = {};
    for (const [resourceId, versions] of this.versionMap.entries()) {
      result[resourceId] = versions;
    }
    return result;
  }
}
