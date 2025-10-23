import { useEffect, useRef } from "react";
import { useRoute } from "wouter";
import { useQuery } from "@tanstack/react-query";

interface ApiAsset {
  id: string;
  title: string;
  content?: string;
  metadata?: {
    description?: string;
    [key: string]: any;
  };
  currentLayer?: string;
  createdAt: string;
  didPeer?: string | null;
  didWebvh?: string | null;
  didBtco?: string | null;
}

export default function AssetDetail() {
  const [match, params] = useRoute("/asset/:id");
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const assetId = params?.id;

  // Fetch asset details
  const { data: asset, isLoading } = useQuery<ApiAsset>({
    queryKey: [`/api/assets/${assetId}`],
    enabled: !!assetId,
  });

  useEffect(() => {
    // Focus the text area
    setTimeout(() => {
      if (textAreaRef.current) {
        textAreaRef.current.focus();
      }
    }, 100);
  }, [asset]);

  if (!match) {
    return null;
  }

  const content = asset?.content || asset?.metadata?.description || '';
  const layerDisplay = asset?.currentLayer || 'did:peer';

  return (
    <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 relative">
      <div className="bg-white min-h-96 p-4 sm:p-6">
        {isLoading ? (
          <div className="flex items-center justify-center h-96">
            <div className="text-gray-500">Loading asset...</div>
          </div>
        ) : asset ? (
          <>
            <div className="mb-4 pb-3 border-b border-gray-200">
              <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">
                {layerDisplay}
              </div>
              <h2 className="text-lg font-medium text-gray-900">
                {asset.title}
              </h2>
              <div className="text-xs text-gray-400 mt-1">
                {new Date(asset.createdAt).toLocaleString()}
              </div>
            </div>
            <textarea
              ref={textAreaRef}
              value={content}
              readOnly
              className="w-full h-96 py-2 px-3 text-gray-900 leading-relaxed text-base font-normal outline-none border-none resize-none bg-transparent"
              placeholder="No content available..."
              data-testid="asset-text-area"
              style={{
                fontFamily: 'inherit'
              }}
            />
          </>
        ) : (
          <div className="flex items-center justify-center h-96">
            <div className="text-gray-500">Asset not found</div>
          </div>
        )}
      </div>
    </main>
  );
}
