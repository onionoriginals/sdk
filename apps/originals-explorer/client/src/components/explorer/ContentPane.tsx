/**
 * Content pane component for the right side
 * Shows selected asset details, preview, and grid/list view of assets
 */

import { useLocation } from 'wouter';
import {
  File,
  Image,
  Music,
  Video,
  FileText,
  Calendar,
  Clock,
  Tag,
  ExternalLink,
  Edit,
  Trash2,
  Share2,
} from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { Asset, AssetType, ViewMode } from './types';
import { formatDate, formatFileSize } from './utils';

interface ContentPaneProps {
  assets: Asset[];
  selectedAsset?: Asset;
  viewMode: ViewMode;
  onAssetSelect: (asset: Asset) => void;
}

const assetTypeIcons: Record<AssetType, typeof File> = {
  document: FileText,
  image: Image,
  audio: Music,
  video: Video,
  other: File,
};

const layerColors = {
  private: 'bg-blue-100 text-blue-700 border-blue-200',
  public: 'bg-green-100 text-green-700 border-green-200',
  property: 'bg-orange-100 text-orange-700 border-orange-200',
};

const layerLabels = {
  private: 'Private',
  public: 'Public',
  property: 'Property',
};

export function ContentPane({
  assets,
  selectedAsset,
  viewMode,
  onAssetSelect,
}: ContentPaneProps) {
  const [, navigate] = useLocation();

  const getAssetIcon = (type: AssetType) => {
    return assetTypeIcons[type] || File;
  };

  // Grid view
  const renderGridView = () => (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4 p-4">
      {assets.map((asset) => {
        const AssetIcon = getAssetIcon(asset.type);
        const isSelected = selectedAsset?.id === asset.id;

        return (
          <Card
            key={asset.id}
            className={cn(
              "cursor-pointer transition-all duration-150 hover:shadow-md",
              isSelected && "ring-2 ring-primary"
            )}
            onClick={() => onAssetSelect(asset)}
          >
            <CardContent className="p-4">
              <div className="flex flex-col items-center text-center">
                {/* Icon or thumbnail */}
                <div className="w-16 h-16 mb-3 flex items-center justify-center rounded-lg bg-muted">
                  <AssetIcon className="w-8 h-8 text-muted-foreground" />
                </div>

                {/* Title */}
                <h3 className="text-sm font-medium truncate w-full mb-1">
                  {asset.title}
                </h3>

                {/* Metadata */}
                <p className="text-xs text-muted-foreground">
                  {formatDate(asset.updatedAt)}
                </p>

                {/* Layer badge */}
                <Badge
                  variant="outline"
                  className={cn("mt-2 text-xs", layerColors[asset.layer])}
                >
                  {layerLabels[asset.layer]}
                </Badge>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );

  // List view
  const renderListView = () => (
    <div className="divide-y">
      {assets.map((asset) => {
        const AssetIcon = getAssetIcon(asset.type);
        const isSelected = selectedAsset?.id === asset.id;

        return (
          <div
            key={asset.id}
            className={cn(
              "flex items-center gap-4 px-4 py-3 cursor-pointer hover:bg-accent transition-colors",
              isSelected && "bg-accent"
            )}
            onClick={() => onAssetSelect(asset)}
          >
            {/* Icon */}
            <div className="w-10 h-10 flex items-center justify-center rounded-lg bg-muted shrink-0">
              <AssetIcon className="w-5 h-5 text-muted-foreground" />
            </div>

            {/* Info */}
            <div className="flex-1 min-w-0">
              <h3 className="text-sm font-medium truncate">{asset.title}</h3>
              <p className="text-xs text-muted-foreground">
                {formatDate(asset.updatedAt)}
                {asset.size && ` • ${formatFileSize(asset.size)}`}
              </p>
            </div>

            {/* Layer badge */}
            <Badge
              variant="outline"
              className={cn("text-xs shrink-0", layerColors[asset.layer])}
            >
              {layerLabels[asset.layer]}
            </Badge>
          </div>
        );
      })}
    </div>
  );

  // Asset details panel
  const renderDetailsPanel = () => {
    if (!selectedAsset) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-center p-8">
          <File className="w-16 h-16 text-muted-foreground mb-4" />
          <h3 className="text-lg font-medium mb-2">No asset selected</h3>
          <p className="text-sm text-muted-foreground max-w-sm">
            Select an asset from the list to view its details and preview
          </p>
        </div>
      );
    }

    const AssetIcon = getAssetIcon(selectedAsset.type);

    return (
      <div className="h-full flex flex-col">
        {/* Preview area */}
        <div className="bg-muted/30 p-8 flex items-center justify-center border-b min-h-[240px]">
          <div className="w-24 h-24 flex items-center justify-center rounded-lg bg-background shadow-sm">
            <AssetIcon className="w-12 h-12 text-muted-foreground" />
          </div>
        </div>

        {/* Details */}
        <ScrollArea className="flex-1">
          <div className="p-6 space-y-6">
            {/* Title and layer */}
            <div>
              <div className="flex items-start justify-between gap-4 mb-2">
                <h2 className="text-xl font-semibold">{selectedAsset.title}</h2>
                <Badge
                  variant="outline"
                  className={cn(layerColors[selectedAsset.layer])}
                >
                  {layerLabels[selectedAsset.layer]}
                </Badge>
              </div>
            </div>

            <Separator />

            {/* Metadata */}
            <div className="space-y-3">
              <h3 className="text-sm font-semibold">Details</h3>

              <div className="space-y-2 text-sm">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Calendar className="w-4 h-4" />
                  <span>Created: {formatDate(selectedAsset.createdAt)}</span>
                </div>
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Clock className="w-4 h-4" />
                  <span>Modified: {formatDate(selectedAsset.updatedAt)}</span>
                </div>
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Tag className="w-4 h-4" />
                  <span>Type: {selectedAsset.type}</span>
                </div>
                {selectedAsset.size && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <File className="w-4 h-4" />
                    <span>Size: {formatFileSize(selectedAsset.size)}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Content preview */}
            {selectedAsset.content && (
              <>
                <Separator />
                <div className="space-y-3">
                  <h3 className="text-sm font-semibold">Content Preview</h3>
                  <div className="text-sm text-muted-foreground bg-muted/50 rounded-md p-4 max-h-40 overflow-auto">
                    {selectedAsset.content.substring(0, 500)}
                    {selectedAsset.content.length > 500 && '...'}
                  </div>
                </div>
              </>
            )}

            <Separator />

            {/* Actions */}
            <div className="space-y-2">
              <Button
                className="w-full"
                onClick={() => navigate(`/asset/${selectedAsset.id}`)}
              >
                <ExternalLink className="w-4 h-4 mr-2" />
                View Full Details
              </Button>
              <div className="grid grid-cols-3 gap-2">
                <Button variant="outline" size="sm">
                  <Edit className="w-4 h-4" />
                </Button>
                <Button variant="outline" size="sm">
                  <Share2 className="w-4 h-4" />
                </Button>
                <Button variant="outline" size="sm">
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </div>
          </div>
        </ScrollArea>
      </div>
    );
  };

  return (
    <div className="flex h-full">
      {/* Main content area */}
      <div className="flex-1 bg-background">
        {assets.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center p-8">
            <File className="w-16 h-16 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2">No assets found</h3>
            <p className="text-sm text-muted-foreground max-w-sm mb-4">
              Create your first asset to get started
            </p>
            <Button onClick={() => navigate('/create')}>Create Asset</Button>
          </div>
        ) : (
          <ScrollArea className="h-full">
            {viewMode === 'grid' ? renderGridView() : renderListView()}
          </ScrollArea>
        )}
      </div>

      {/* Details panel (only show in details view mode or when asset is selected) */}
      {selectedAsset && (
        <>
          <Separator orientation="vertical" />
          <div className="w-80 bg-background">{renderDetailsPanel()}</div>
        </>
      )}
    </div>
  );
}
