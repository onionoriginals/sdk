import { useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Plus, ArrowRight, ArrowRightLeft, Check, ArrowRightLeft as Exchange, FileSpreadsheet } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { LayerBadge } from "@/components/LayerBadge";
import { LayerFilter } from "@/components/LayerFilter";
import type { AssetLayer } from "../../../shared/schema";

export default function Dashboard() {
  const [selectedLayer, setSelectedLayer] = useState<AssetLayer | 'all'>('all');

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
  }>>({
    queryKey: ["/api/assets", { layer: selectedLayer }],
    queryFn: async () => {
      const params = selectedLayer !== 'all' ? `?layer=${selectedLayer}` : '';
      const response = await fetch(`/api/assets${params}`, {
        credentials: 'include'
      });
      if (!response.ok) throw new Error('Failed to fetch assets');
      return response.json();
    }
  });

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
    </main>
  );
}
