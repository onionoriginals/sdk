/**
 * Dual-pane explorer component
 * Main component that orchestrates the entire explorer UI
 */

import { useState, useEffect, useMemo } from 'react';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';
import { ExplorerTopBar } from './ExplorerTopBar';
import { DirectoryTree } from './DirectoryTree';
import { ContentPane } from './ContentPane';
import {
  Asset,
  FolderNode,
  ViewMode,
  SortField,
  SortOrder,
} from './types';
import {
  loadAssets,
  createFolderStructure,
  filterAssets,
} from './utils';

export function DualPaneExplorer() {
  // State management
  const [assets, setAssets] = useState<Asset[]>([]);
  const [folders, setFolders] = useState<FolderNode[]>([]);
  const [selectedAsset, setSelectedAsset] = useState<Asset | undefined>();
  const [selectedFolder, setSelectedFolder] = useState<string>('private');
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [sortField, setSortField] = useState<SortField>('updatedAt');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');

  // Load assets on mount and listen for updates
  useEffect(() => {
    loadAssetsFromStorage();

    // Listen for storage changes
    const handleStorageChange = () => {
      loadAssetsFromStorage();
    };

    window.addEventListener('storage', handleStorageChange);
    window.addEventListener('originals-documents-updated', handleStorageChange);

    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('originals-documents-updated', handleStorageChange);
    };
  }, []);

  // Update folder structure when assets change
  useEffect(() => {
    const folderStructure = createFolderStructure(assets);
    setFolders(folderStructure);
  }, [assets]);

  const loadAssetsFromStorage = () => {
    const loadedAssets = loadAssets();
    setAssets(loadedAssets);
  };

  const handleRefresh = () => {
    loadAssetsFromStorage();
  };

  const handleFolderToggle = (folderId: string) => {
    setFolders(prev =>
      prev.map(folder =>
        folder.id === folderId
          ? { ...folder, expanded: !folder.expanded }
          : folder
      )
    );
  };

  const handleAssetSelect = (asset: Asset) => {
    setSelectedAsset(asset);
    setSelectedFolder(asset.layer);
  };

  const handleSortChange = (field: SortField, order: SortOrder) => {
    setSortField(field);
    setSortOrder(order);
  };

  // Get current path for breadcrumbs
  const currentPath = useMemo(() => {
    const folder = folders.find(f => f.id === selectedFolder);
    if (!folder) return [];
    if (selectedAsset) {
      return [folder.name, selectedAsset.title];
    }
    return [folder.name];
  }, [folders, selectedFolder, selectedAsset]);

  // Filter and sort assets for the current view
  const visibleAssets = useMemo(() => {
    // Get assets from all folders or selected folder
    let assetsToShow = assets;

    // Filter by search query
    if (searchQuery.trim()) {
      assetsToShow = filterAssets(assetsToShow, searchQuery);
    }

    // Sort assets
    const sorted = [...assetsToShow].sort((a, b) => {
      let comparison = 0;

      switch (sortField) {
        case 'title':
          comparison = a.title.localeCompare(b.title);
          break;
        case 'updatedAt':
          comparison = new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
          break;
        case 'type':
          comparison = a.type.localeCompare(b.type);
          break;
        case 'size':
          comparison = (a.size || 0) - (b.size || 0);
          break;
      }

      return sortOrder === 'asc' ? comparison : -comparison;
    });

    return sorted;
  }, [assets, searchQuery, sortField, sortOrder]);

  return (
    <div className="flex flex-col h-full w-full">
      {/* Top bar */}
      <ExplorerTopBar
        currentPath={currentPath}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        onRefresh={handleRefresh}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        sortField={sortField}
        sortOrder={sortOrder}
        onSortChange={handleSortChange}
      />

      {/* Dual-pane layout with resizable panels */}
      <div className="flex-1 overflow-hidden">
        <ResizablePanelGroup direction="horizontal" className="h-full">
          {/* Left pane - Directory tree */}
          <ResizablePanel
            defaultSize={20}
            minSize={15}
            maxSize={35}
            className="min-w-[200px]"
          >
            <DirectoryTree
              folders={folders}
              selectedAssetId={selectedAsset?.id}
              onAssetSelect={handleAssetSelect}
              onFolderToggle={handleFolderToggle}
              searchQuery={searchQuery}
            />
          </ResizablePanel>

          {/* Resize handle */}
          <ResizableHandle withHandle />

          {/* Right pane - Content view */}
          <ResizablePanel defaultSize={80} minSize={50}>
            <ContentPane
              assets={visibleAssets}
              selectedAsset={selectedAsset}
              viewMode={viewMode}
              onAssetSelect={handleAssetSelect}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}
