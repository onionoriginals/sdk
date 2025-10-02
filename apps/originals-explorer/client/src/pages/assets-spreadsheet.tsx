import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { SpreadsheetView } from "@/components/spreadsheet/SpreadsheetView";
import { defaultAssetColumns, type AssetRow } from "@/components/spreadsheet/columns";
import { useAuth } from "@/hooks/useAuth";
import { apiRequest } from "@/lib/queryClient";

export default function AssetsSpreadsheet() {
  const { user, isAuthenticated } = useAuth();

  const { data: assets = [] } = useQuery<AssetRow[]>({
    queryKey: ["/api/assets", user?.id ?? ""],
    enabled: !!user?.id,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/assets?userId=${encodeURIComponent(user!.id)}`);
      return await res.json();
    }
  });

  const rows: AssetRow[] = useMemo(() => {
    return (assets || []).map((a: any) => ({
      id: a.id,
      title: a.title,
      assetType: a.assetType,
      status: a.status,
      category: a.category ?? null,
      tags: a.tags ?? null,
      mediaUrl: a.mediaUrl ?? null,
      metadata: a.metadata ?? null,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    }));
  }, [assets]);

  if (!isAuthenticated) {
    return (
      <main className="max-w-6xl mx-auto px-8 py-8">
        <div className="mb-6">
          <h1 className="page-title">Assets</h1>
          <p className="text-gray-500 text-sm">Spreadsheet view of your Originals assets</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-sm p-8 text-center">
          <p className="text-gray-500">Please sign in to view your assets.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="max-w-6xl mx-auto px-8 py-8">
      <div className="mb-6">
        <h1 className="page-title">Assets</h1>
        <p className="text-gray-500 text-sm">Spreadsheet view of your Originals assets</p>
      </div>

      <SpreadsheetView columns={defaultAssetColumns} rows={rows} />
    </main>
  );
}


