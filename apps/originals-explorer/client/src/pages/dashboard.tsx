import { useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Plus, ArrowRight, ArrowRightLeft, Check, ArrowRightLeft as Exchange, FileSpreadsheet, Globe, Loader2, CheckCircle, AlertCircle, ExternalLink } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LayerBadge } from "@/components/LayerBadge";
import { LayerFilter } from "@/components/LayerFilter";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type { AssetLayer } from "../../../shared/schema";

interface PublishResult {
  success: boolean;
  message: string;
  asset: {
    id: string;
    title: string;
    currentLayer: AssetLayer;
    didPeer: string | null;
    didWebvh: string | null;
    provenance: any;
  };
  resolverUrl: string;
  migration: any;
}

export default function Dashboard() {
  const [selectedLayer, setSelectedLayer] = useState<AssetLayer | 'all'>('all');
  const [showPublishModal, setShowPublishModal] = useState(false);
  const [selectedAssetForPublish, setSelectedAssetForPublish] = useState<any | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [publishResult, setPublishResult] = useState<PublishResult | null>(null);
  
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: stats } = useQuery<{ 
    totalAssets: number; 
    verifiedAssets: number; 
    migratedAssets: number; 
  }>({
    queryKey: ["/api/stats"],
  });

  const { data: recentAssets } = useQuery<Array<{
    id: string;
    title: string;
    assetType: string;
    status: string;
    createdAt: string;
    currentLayer?: AssetLayer;
    userId?: string;
    didPeer?: string | null;
    didWebvh?: string | null;
  }>>({
    queryKey: selectedLayer !== 'all' ? [`/api/assets?layer=${selectedLayer}`] : ["/api/assets"],
  });

  // Get current user
  const { data: currentUser } = useQuery<{ id: string; did: string; privyId: string }>({
    queryKey: ["/api/user"],
  });

  const handlePublishToWeb = (asset: any) => {
    setSelectedAssetForPublish(asset);
    setPublishError(null);
    setPublishResult(null);
    setShowPublishModal(true);
  };

  const confirmPublish = async () => {
    if (!selectedAssetForPublish) return;
    
    setIsPublishing(true);
    setPublishError(null);
    
    try {
      const response = await apiRequest('POST', `/api/assets/${selectedAssetForPublish.id}/publish-to-web`, {
        // Optional: domain: 'custom.domain.com'
      });
      
      const result = await response.json();
      setPublishResult(result);
      
      // Refresh assets list
      queryClient.invalidateQueries({ queryKey: ["/api/assets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      
      // Show success notification
      toast({
        title: "Asset published to web successfully!",
        description: `Your asset is now publicly accessible at ${result.asset.didWebvh}`,
      });
      
    } catch (error: any) {
      console.error('Publish error:', error);
      setPublishError(error.message);
      toast({
        title: "Publish failed",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsPublishing(false);
    }
  };

  const closePublishModal = () => {
    setShowPublishModal(false);
    setSelectedAssetForPublish(null);
    setPublishError(null);
    setPublishResult(null);
  };

  return (
    <main className="max-w-4xl mx-auto px-8 py-16">
      {/* Simple Header */}
      <div className="mb-12">
        <h1 className="page-title">
          Digital Asset Authentication
        </h1>
        <p className="text-gray-500 text-base leading-relaxed max-w-2xl mb-8">
          Create authenticated digital assets or migrate existing Ordinals with verifiable credentials.
        </p>
        
        {/* Action Buttons */}
        <div className="flex gap-4">
          <Link href="/create">
            <Button className="minimal-button" data-testid="create-asset-button">
              <Plus className="w-4 h-4 mr-2" />
              Create Asset
            </Button>
          </Link>
          <Link href="/upload-assets">
            <Button variant="outline" className="border-gray-200 hover:bg-gray-50" data-testid="upload-spreadsheet-button">
              <FileSpreadsheet className="w-4 h-4 mr-2" />
              Upload Spreadsheet
            </Button>
          </Link>
          <Link href="/migrate">
            <Button variant="outline" className="border-gray-200 hover:bg-gray-50" data-testid="migrate-asset-button">
              <Exchange className="w-4 h-4 mr-2" />
              Migrate Ordinal
            </Button>
          </Link>
        </div>
      </div>

      {/* Stats in minimal format */}
      <div className="grid grid-cols-3 gap-12 mb-16">
        <div className="text-center">
          <div className="text-2xl font-light text-gray-900 mb-2" data-testid="stat-total-assets">
            {stats?.totalAssets || 0}
          </div>
          <div className="text-xs text-gray-500 tracking-wide uppercase">Assets Created</div>
        </div>
        <div className="text-center">
          <div className="text-2xl font-light text-gray-900 mb-2" data-testid="stat-verified-assets">
            {stats?.verifiedAssets || 0}
          </div>
          <div className="text-xs text-gray-500 tracking-wide uppercase">Verified</div>
        </div>
        <div className="text-center">
          <div className="text-2xl font-light text-gray-900 mb-2" data-testid="stat-migrated-assets">
            {stats?.migratedAssets || 0}
          </div>
          <div className="text-xs text-gray-500 tracking-wide uppercase">Migrated</div>
        </div>
      </div>

      {/* Recent Activity - Directory Style */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h3 className="section-title">Recent Activity</h3>
          <LayerFilter value={selectedLayer} onChange={setSelectedLayer} />
        </div>
        
        {recentAssets && recentAssets.length > 0 ? (
          <div className="bg-white border border-gray-200 rounded-sm">
            {recentAssets.slice(0, 10).map((asset: any, index: number) => (
              <div 
                key={asset.id}
                className={`flex items-center justify-between py-4 px-6 ${
                  index < recentAssets.length - 1 ? 'border-b border-gray-100' : ''
                }`}
                data-testid={`activity-item-${asset.id}`}
              >
                <div className="flex items-center gap-4">
                  {asset.assetType === 'migrated' ? (
                    <ArrowRightLeft className="w-4 h-4 text-gray-400" />
                  ) : (
                    <Check className="w-4 h-4 text-gray-400" />
                  )}
                  <div>
                    <div className="text-sm font-medium text-gray-700 mb-1">
                      {asset.title}
                    </div>
                    <div className="text-xs text-gray-500">
                      {asset.assetType === 'migrated' ? 'Migrated' : 'Created'} • {' '}
                      {new Date(asset.createdAt).toLocaleDateString()}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {asset.currentLayer && (
                    <LayerBadge layer={asset.currentLayer} size="sm" />
                  )}
                  <div className="text-xs text-gray-400 px-2 py-1 bg-gray-50 rounded-sm">
                    {asset.status === 'completed' ? 'Complete' : 'In Progress'}
                  </div>
                  {/* Publish to Web button - only for did:peer assets owned by current user */}
                  {asset.currentLayer === 'did:peer' && currentUser && asset.userId === currentUser.id && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handlePublishToWeb(asset)}
                      className="text-xs text-blue-600 hover:text-blue-800 hover:bg-blue-50"
                    >
                      <Globe className="w-3 h-3 mr-1" />
                      Publish
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="bg-white border border-gray-200 rounded-sm py-16 text-center">
            <p className="text-gray-500 text-sm mb-4">
              {selectedLayer !== 'all' 
                ? `No assets in ${selectedLayer} layer` 
                : 'No recent activity'}
            </p>
            <p className="text-gray-400 text-xs">Create your first asset to get started</p>
          </div>
        )}
      </div>

      {/* Publish Confirmation Modal */}
      <Dialog open={showPublishModal} onOpenChange={setShowPublishModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Publish Asset to Web?</DialogTitle>
            <DialogDescription className="space-y-3 pt-4">
              {!publishResult ? (
                <>
                  <p>
                    This will migrate your asset from <LayerBadge layer="did:peer" size="sm" />
                    {' '}to <LayerBadge layer="did:webvh" size="sm" />
                  </p>
                  
                  <div className="bg-blue-50 border border-blue-200 rounded-sm p-3">
                    <h4 className="text-sm font-medium text-blue-900 mb-2">What happens:</h4>
                    <ul className="text-sm text-blue-800 space-y-1 list-disc list-inside">
                      <li>Asset becomes publicly accessible via HTTPS</li>
                      <li>DID becomes resolvable on the web</li>
                      <li>Provenance is updated with migration event</li>
                      <li>Original did:peer is preserved for history</li>
                    </ul>
                  </div>
                  
                  <div className="bg-yellow-50 border border-yellow-200 rounded-sm p-3">
                    <h4 className="text-sm font-medium text-yellow-900 mb-2">Note:</h4>
                    <p className="text-sm text-yellow-800">
                      Once published, your asset will be publicly visible.
                    </p>
                  </div>
                </>
              ) : (
                <div className="mt-4 p-4 bg-blue-50 border border-blue-200 rounded-sm">
                  <div className="flex items-center gap-2 mb-3">
                    <CheckCircle className="w-5 h-5 text-blue-600" />
                    <h4 className="font-medium text-blue-900">Published to Web!</h4>
                  </div>
                  
                  <div className="space-y-3">
                    {/* New Layer */}
                    <div>
                      <div className="text-xs text-blue-700 mb-1">Current Layer</div>
                      <LayerBadge layer="did:webvh" size="md" />
                    </div>
                    
                    {/* Original DID */}
                    {publishResult.asset.didPeer && (
                      <div>
                        <div className="text-xs text-blue-700 mb-1">Original DID (did:peer)</div>
                        <div className="font-mono text-xs text-blue-800 bg-white p-2 rounded-sm border border-blue-200 break-all">
                          {publishResult.asset.didPeer}
                        </div>
                      </div>
                    )}
                    
                    {/* New DID */}
                    <div>
                      <div className="text-xs text-blue-700 mb-1">Web DID (did:webvh)</div>
                      <div className="font-mono text-xs text-blue-900 bg-white p-2 rounded-sm border border-blue-200 break-all">
                        {publishResult.asset.didWebvh}
                      </div>
                    </div>
                    
                    {/* Resolution URL */}
                    {publishResult.resolverUrl && (
                      <div>
                        <div className="text-xs text-blue-700 mb-1">Resolver URL</div>
                        <a 
                          href={publishResult.resolverUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm text-blue-600 hover:text-blue-800 underline flex items-center gap-1"
                        >
                          {publishResult.resolverUrl}
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      </div>
                    )}
                    
                    {/* Provenance Update */}
                    {publishResult.migration?.timestamp && (
                      <div>
                        <div className="text-xs text-blue-700 mb-1">Provenance</div>
                        <div className="text-xs text-blue-800 bg-white p-2 rounded-sm border border-blue-200">
                          Migration event recorded: {new Date(publishResult.migration.timestamp).toLocaleString()}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Error Display */}
              {publishError && (
                <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-sm">
                  <div className="flex items-center gap-2 mb-2">
                    <AlertCircle className="w-4 h-4 text-red-600" />
                    <h4 className="font-medium text-red-900">Publish Failed</h4>
                  </div>
                  <p className="text-sm text-red-700">{publishError}</p>
                </div>
              )}
            </DialogDescription>
          </DialogHeader>
          
          <DialogFooter>
            {!publishResult ? (
              <>
                <Button 
                  variant="outline" 
                  onClick={closePublishModal}
                  disabled={isPublishing}
                >
                  Cancel
                </Button>
                <Button 
                  onClick={confirmPublish}
                  disabled={isPublishing}
                >
                  {isPublishing ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Publishing...
                    </>
                  ) : (
                    'Publish to Web'
                  )}
                </Button>
              </>
            ) : (
              <Button onClick={closePublishModal}>
                Close
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
