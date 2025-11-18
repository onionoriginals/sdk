/**
 * Directory tree component for the left pane
 * Shows folder structure with expandable/collapsible sections
 */

import { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Folder,
  Globe,
  DollarSign,
  File,
  Image,
  Music,
  Video,
  FileText,
} from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { FolderNode, Asset, AssetType } from './types';

interface DirectoryTreeProps {
  folders: FolderNode[];
  selectedAssetId?: string;
  onAssetSelect: (asset: Asset) => void;
  onFolderToggle: (folderId: string) => void;
  searchQuery: string;
}

const folderIcons = {
  private: Folder,
  public: Globe,
  property: DollarSign,
};

const folderColors = {
  private: 'text-blue-500',
  public: 'text-green-500',
  property: 'text-orange-500',
};

const assetTypeIcons: Record<AssetType, typeof File> = {
  document: FileText,
  image: Image,
  audio: Music,
  video: Video,
  other: File,
};

export function DirectoryTree({
  folders,
  selectedAssetId,
  onAssetSelect,
  onFolderToggle,
  searchQuery,
}: DirectoryTreeProps) {
  const getAssetIcon = (type: AssetType) => {
    return assetTypeIcons[type] || File;
  };

  const filterAssets = (assets: Asset[]) => {
    if (!searchQuery.trim()) return assets;
    const query = searchQuery.toLowerCase();
    return assets.filter(
      (asset) =>
        asset.title.toLowerCase().includes(query) ||
        asset.content?.toLowerCase().includes(query)
    );
  };

  return (
    <div className="flex flex-col h-full bg-muted/30">
      {/* Header */}
      <div className="px-4 py-3 border-b bg-background">
        <h2 className="text-sm font-semibold">Folders</h2>
      </div>

      {/* Folder tree */}
      <ScrollArea className="flex-1">
        <div className="p-2">
          {folders.map((folder) => {
            const FolderIcon = folderIcons[folder.layer];
            const filteredAssets = filterAssets(folder.assets);
            const hasVisibleAssets = filteredAssets.length > 0;

            return (
              <div key={folder.id} className="mb-1">
                {/* Folder header */}
                <Button
                  variant="ghost"
                  className={cn(
                    "w-full justify-start px-2 h-9 hover:bg-accent",
                    "transition-colors duration-150"
                  )}
                  onClick={() => onFolderToggle(folder.id)}
                >
                  {folder.expanded ? (
                    <ChevronDown className="h-4 w-4 mr-1 text-muted-foreground shrink-0" />
                  ) : (
                    <ChevronRight className="h-4 w-4 mr-1 text-muted-foreground shrink-0" />
                  )}
                  <FolderIcon
                    className={cn(
                      "h-4 w-4 mr-2 shrink-0",
                      folderColors[folder.layer]
                    )}
                  />
                  <div className="flex flex-col items-start flex-1 min-w-0">
                    <span className="text-sm font-medium truncate w-full">
                      {folder.name}
                    </span>
                    <span className="text-xs text-muted-foreground truncate w-full">
                      {filteredAssets.length} {filteredAssets.length === 1 ? 'item' : 'items'}
                    </span>
                  </div>
                </Button>

                {/* Folder contents */}
                {folder.expanded && hasVisibleAssets && (
                  <div className="ml-6 mt-1 space-y-0.5">
                    {filteredAssets.map((asset) => {
                      const AssetIcon = getAssetIcon(asset.type);
                      const isSelected = selectedAssetId === asset.id;

                      return (
                        <Button
                          key={asset.id}
                          variant="ghost"
                          className={cn(
                            "w-full justify-start px-2 h-8 text-sm hover:bg-accent",
                            "transition-colors duration-150",
                            isSelected && "bg-accent"
                          )}
                          onClick={() => onAssetSelect(asset)}
                        >
                          <AssetIcon className="h-4 w-4 mr-2 text-muted-foreground shrink-0" />
                          <span className="truncate">{asset.title}</span>
                        </Button>
                      );
                    })}
                  </div>
                )}

                {folder.expanded && !hasVisibleAssets && searchQuery && (
                  <div className="ml-6 mt-1 px-2 py-2 text-xs text-muted-foreground">
                    No matching assets
                  </div>
                )}

                {folder.expanded && folder.assets.length === 0 && !searchQuery && (
                  <div className="ml-6 mt-1 px-2 py-2 text-xs text-muted-foreground">
                    No assets yet
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </ScrollArea>

      {/* Footer stats */}
      <div className="px-4 py-2 border-t bg-background">
        <div className="text-xs text-muted-foreground">
          {folders.reduce((sum, f) => sum + f.assets.length, 0)} total assets
        </div>
      </div>
    </div>
  );
}
