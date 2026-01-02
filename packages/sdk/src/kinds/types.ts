/**
 * Originals Kind System Types
 * 
 * Defines the typed "Kinds" for Originals - a classification system that
 * enables kind-specific validation, metadata schemas, and behaviors.
 */

import type { AssetResource } from '../types/common';

/**
 * The supported Original kinds
 * Each kind represents a category of digital asset with specific requirements
 */
export enum OriginalKind {
  /** Executable application with runtime and entrypoint */
  App = 'originals:kind:app',
  
  /** AI agent or autonomous system with capabilities and model info */
  Agent = 'originals:kind:agent',
  
  /** Reusable code module with exports and dependencies */
  Module = 'originals:kind:module',
  
  /** Structured data collection with schema definition */
  Dataset = 'originals:kind:dataset',
  
  /** Media content (image, audio, video) with format metadata */
  Media = 'originals:kind:media',
  
  /** Text document with formatting and sections */
  Document = 'originals:kind:document',
}

/**
 * Reference to a dependency Original
 */
export interface DependencyRef {
  /** DID of the dependency Original */
  did: string;
  
  /** Semantic version constraint (e.g., "^1.0.0", ">=2.0.0") */
  version?: string;
  
  /** Human-readable name of the dependency */
  name?: string;
  
  /** Whether this dependency is required (default: true) */
  optional?: boolean;
}

/**
 * Base manifest fields shared by all kinds
 */
export interface BaseManifest {
  /** Human-readable name */
  name: string;
  
  /** Semantic version string (e.g., "1.0.0") */
  version: string;
  
  /** Optional description */
  description?: string;
  
  /** Resources associated with this Original */
  resources: AssetResource[];
  
  /** Dependencies on other Originals */
  dependencies?: DependencyRef[];
  
  /** Free-form tags for categorization */
  tags?: string[];
  
  /** Author information */
  author?: {
    name?: string;
    did?: string;
    email?: string;
    url?: string;
  };
  
  /** License identifier (SPDX) */
  license?: string;
  
  /** URL for more information */
  homepage?: string;
  
  /** Repository URL */
  repository?: string;
}

/**
 * App-specific metadata
 */
export interface AppMetadata {
  /** Runtime environment (e.g., "node", "browser", "deno", "bun") */
  runtime: string;
  
  /** Entrypoint resource ID or path */
  entrypoint: string;
  
  /** Required runtime version */
  runtimeVersion?: string;
  
  /** Minimum required runtime version */
  minRuntimeVersion?: string;
  
  /** App permissions required */
  permissions?: string[];
  
  /** Environment variables expected */
  env?: Record<string, {
    description?: string;
    required?: boolean;
    default?: string;
  }>;
  
  /** Supported platforms */
  platforms?: ('linux' | 'darwin' | 'windows' | 'web')[];
  
  /** App icons by size */
  icons?: Record<string, string>;
  
  /** CLI commands exposed */
  commands?: Record<string, {
    description: string;
    args?: string[];
  }>;
}

/**
 * Agent-specific metadata
 */
export interface AgentMetadata {
  /** Agent capabilities/skills */
  capabilities: string[];
  
  /** Model information if AI-based */
  model?: {
    provider?: string;
    name: string;
    version?: string;
    parameters?: Record<string, unknown>;
  };
  
  /** Input types the agent accepts */
  inputTypes?: string[];
  
  /** Output types the agent produces */
  outputTypes?: string[];
  
  /** Memory/state configuration */
  memory?: {
    type: 'stateless' | 'session' | 'persistent';
    maxSize?: number;
  };
  
  /** System prompt or instructions */
  systemPrompt?: string;
  
  /** Tools/functions the agent can use */
  tools?: Array<{
    name: string;
    description: string;
    parameters?: Record<string, unknown>;
  }>;
  
  /** Rate limiting configuration */
  rateLimit?: {
    requestsPerMinute?: number;
    tokensPerMinute?: number;
  };
}

/**
 * Module-specific metadata
 */
export interface ModuleMetadata {
  /** Module format (esm, commonjs, umd, etc.) */
  format: 'esm' | 'commonjs' | 'umd' | 'amd' | 'iife';
  
  /** Main entrypoint file (resource ID) */
  main: string;
  
  /** Types definition file (resource ID) */
  types?: string;
  
  /** Exported symbols/functions */
  exports?: Record<string, string | { import?: string; require?: string; types?: string }>;
  
  /** Peer dependencies (expected to be provided by consumer) */
  peerDependencies?: Record<string, string>;
  
  /** Browser-specific entrypoint */
  browser?: string;
  
  /** Files included in the module */
  files?: string[];
  
  /** Side effects declaration */
  sideEffects?: boolean | string[];
  
  /** TypeScript configuration */
  typescript?: {
    strict?: boolean;
    target?: string;
    moduleResolution?: string;
  };
}

/**
 * Dataset-specific metadata
 */
export interface DatasetMetadata {
  /** Schema definition (JSON Schema, or URL to schema) */
  schema: Record<string, unknown> | string;
  
  /** Data format (csv, json, parquet, etc.) */
  format: string;
  
  /** Number of records/rows */
  recordCount?: number;
  
  /** Data columns/fields */
  columns?: Array<{
    name: string;
    type: string;
    description?: string;
    nullable?: boolean;
  }>;
  
  /** Data source information */
  source?: {
    origin?: string;
    collectedAt?: string;
    methodology?: string;
  };
  
  /** Dataset statistics */
  statistics?: {
    sizeBytes?: number;
    compression?: string;
    checksums?: Record<string, string>;
  };
  
  /** License specific to the data */
  dataLicense?: string;
  
  /** Privacy classification */
  privacy?: 'public' | 'internal' | 'confidential' | 'restricted';
  
  /** Update frequency */
  updateFrequency?: 'realtime' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'static';
}

/**
 * Media-specific metadata
 */
export interface MediaMetadata {
  /** Media type (image, audio, video, 3d) */
  mediaType: 'image' | 'audio' | 'video' | '3d' | 'animation';
  
  /** MIME type of the primary media resource */
  mimeType: string;
  
  /** Dimensions (for images and video) */
  dimensions?: {
    width: number;
    height: number;
    aspectRatio?: string;
  };
  
  /** Duration in seconds (for audio/video) */
  duration?: number;
  
  /** Frame rate (for video/animation) */
  frameRate?: number;
  
  /** Audio channels (for audio/video) */
  audioChannels?: number;
  
  /** Sample rate (for audio) */
  sampleRate?: number;
  
  /** Codec information */
  codec?: string;
  
  /** Bitrate in kbps */
  bitrate?: number;
  
  /** Color space */
  colorSpace?: string;
  
  /** Thumbnail resource ID */
  thumbnail?: string;
  
  /** Preview/low-res version resource ID */
  preview?: string;
  
  /** Alt text for accessibility */
  altText?: string;
  
  /** Caption or transcript */
  caption?: string;
  
  /** EXIF or similar metadata */
  exif?: Record<string, unknown>;
}

/**
 * Document-specific metadata
 */
export interface DocumentMetadata {
  /** Document format (markdown, html, pdf, docx, etc.) */
  format: 'markdown' | 'html' | 'pdf' | 'docx' | 'txt' | 'asciidoc' | 'rst' | 'latex';
  
  /** Document language (ISO 639-1) */
  language?: string;
  
  /** Main content resource ID */
  content: string;
  
  /** Table of contents */
  toc?: Array<{
    title: string;
    level: number;
    anchor?: string;
  }>;
  
  /** Page count */
  pageCount?: number;
  
  /** Word count */
  wordCount?: number;
  
  /** Reading time in minutes */
  readingTime?: number;
  
  /** Keywords */
  keywords?: string[];
  
  /** Abstract or summary */
  abstract?: string;
  
  /** Bibliography/references */
  references?: Array<{
    id: string;
    title: string;
    authors?: string[];
    year?: number;
    url?: string;
    doi?: string;
  }>;
  
  /** Document status */
  status?: 'draft' | 'review' | 'published' | 'archived';
  
  /** Revision number */
  revision?: number;
}

/**
 * Maps each kind to its specific metadata type
 */
export interface KindMetadataMap {
  [OriginalKind.App]: AppMetadata;
  [OriginalKind.Agent]: AgentMetadata;
  [OriginalKind.Module]: ModuleMetadata;
  [OriginalKind.Dataset]: DatasetMetadata;
  [OriginalKind.Media]: MediaMetadata;
  [OriginalKind.Document]: DocumentMetadata;
}

/**
 * Type-safe metadata accessor
 */
export type KindMetadata<K extends OriginalKind> = K extends keyof KindMetadataMap
  ? KindMetadataMap[K]
  : never;

/**
 * Generic Original manifest with kind-specific metadata
 */
export interface OriginalManifest<K extends OriginalKind = OriginalKind> extends BaseManifest {
  /** The kind of Original */
  kind: K;
  
  /** Kind-specific metadata */
  metadata: KindMetadata<K>;
}

/**
 * Type-specific manifest aliases for convenience
 */
export type AppManifest = OriginalManifest<OriginalKind.App>;
export type AgentManifest = OriginalManifest<OriginalKind.Agent>;
export type ModuleManifest = OriginalManifest<OriginalKind.Module>;
export type DatasetManifest = OriginalManifest<OriginalKind.Dataset>;
export type MediaManifest = OriginalManifest<OriginalKind.Media>;
export type DocumentManifest = OriginalManifest<OriginalKind.Document>;

/**
 * Union type of all possible manifests
 */
export type AnyManifest = 
  | AppManifest 
  | AgentManifest 
  | ModuleManifest 
  | DatasetManifest 
  | MediaManifest 
  | DocumentManifest;

/**
 * Result of validating a manifest
 */
export interface ValidationResult {
  /** Whether the manifest is valid */
  isValid: boolean;
  
  /** Validation errors if any */
  errors: ValidationError[];
  
  /** Validation warnings (non-fatal) */
  warnings: ValidationWarning[];
}

/**
 * A validation error
 */
export interface ValidationError {
  /** Error code */
  code: string;
  
  /** Human-readable message */
  message: string;
  
  /** Path to the invalid field (e.g., "metadata.entrypoint") */
  path?: string;
  
  /** The invalid value */
  value?: unknown;
}

/**
 * A validation warning (non-fatal issue)
 */
export interface ValidationWarning {
  /** Warning code */
  code: string;
  
  /** Human-readable message */
  message: string;
  
  /** Path to the field with warning */
  path?: string;
  
  /** Suggested fix */
  suggestion?: string;
}

/**
 * Options for creating a typed Original
 */
export interface CreateTypedOriginalOptions {
  /** Skip validation (not recommended) */
  skipValidation?: boolean;
  
  /** Treat warnings as errors */
  strictMode?: boolean;
}

