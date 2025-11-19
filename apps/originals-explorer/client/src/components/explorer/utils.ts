/**
 * Utility functions for the Explorer component
 */

import { Asset, AssetType, FolderNode, AssetLayer } from './types';
import { Folder, Globe, DollarSign } from 'lucide-react';

/**
 * Detect asset type based on title or mime type
 */
export function detectAssetType(title: string, mimeType?: string): AssetType {
  if (mimeType) {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType.startsWith('video/')) return 'video';
  }

  const ext = title.split('.').pop()?.toLowerCase();
  if (!ext) return 'document';

  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'bmp'];
  const audioExts = ['mp3', 'wav', 'ogg', 'flac', 'm4a'];
  const videoExts = ['mp4', 'webm', 'mov', 'avi', 'mkv'];

  if (imageExts.includes(ext)) return 'image';
  if (audioExts.includes(ext)) return 'audio';
  if (videoExts.includes(ext)) return 'video';

  return 'document';
}

/**
 * Convert legacy document format to Asset format
 */
export function convertLegacyDocument(doc: {
  id: string;
  title: string;
  content: string;
  updatedAt: string;
  layer?: 'private' | 'public' | 'property';
}): Asset {
  const layer = doc.layer || 'private';
  return {
    id: doc.id,
    title: doc.title,
    content: doc.content,
    type: detectAssetType(doc.title),
    layer,
    updatedAt: doc.updatedAt,
    createdAt: doc.updatedAt, // Fallback to updatedAt if createdAt not available
    metadata: {},
  };
}

/**
 * Load assets from localStorage
 */
export function loadAssets(): Asset[] {
  const saved = localStorage.getItem("originals-documents");
  if (!saved) return [];

  try {
    const docs = JSON.parse(saved);
    return docs.map(convertLegacyDocument);
  } catch (error) {
    console.error('Failed to load assets:', error);
    return [];
  }
}

/**
 * Create folder structure from assets
 */
export function createFolderStructure(assets: Asset[]): FolderNode[] {
  const folders: FolderNode[] = [
    {
      id: 'private',
      name: 'Private',
      layer: 'private',
      icon: 'Folder',
      color: 'blue',
      description: 'Personal assets',
      expanded: true,
      assets: assets.filter(a => a.layer === 'private'),
    },
    {
      id: 'public',
      name: 'Public',
      layer: 'public',
      icon: 'Globe',
      color: 'green',
      description: 'Shared assets',
      expanded: true,
      assets: assets.filter(a => a.layer === 'public'),
    },
    {
      id: 'property',
      name: 'Property',
      layer: 'property',
      icon: 'DollarSign',
      color: 'orange',
      description: 'Tradable assets',
      expanded: true,
      assets: assets.filter(a => a.layer === 'property'),
    },
  ];

  return folders;
}

/**
 * Format file size for display
 */
export function formatFileSize(bytes?: number): string {
  if (!bytes) return 'Unknown';

  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

/**
 * Format date for display
 */
export function formatDate(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;

  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined
  });
}

/**
 * Filter assets by search query
 */
export function filterAssets(assets: Asset[], query: string): Asset[] {
  if (!query.trim()) return assets;

  const lowerQuery = query.toLowerCase();
  return assets.filter(asset =>
    asset.title.toLowerCase().includes(lowerQuery) ||
    asset.content?.toLowerCase().includes(lowerQuery)
  );
}
