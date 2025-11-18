/**
 * Types for the Dual-Pane Explorer
 */

export type AssetLayer = 'private' | 'public' | 'property';

export type AssetType = 'document' | 'image' | 'audio' | 'video' | 'other';

export interface Asset {
  id: string;
  title: string;
  content?: string;
  type: AssetType;
  layer: AssetLayer;
  updatedAt: string;
  createdAt: string;
  size?: number;
  mimeType?: string;
  thumbnailUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface FolderNode {
  id: string;
  name: string;
  layer: AssetLayer;
  icon: string;
  color: string;
  description: string;
  expanded: boolean;
  assets: Asset[];
}

export interface BreadcrumbItem {
  label: string;
  path: string;
}

export type ViewMode = 'grid' | 'list' | 'details';

export type SortField = 'title' | 'updatedAt' | 'size' | 'type';

export type SortOrder = 'asc' | 'desc';
