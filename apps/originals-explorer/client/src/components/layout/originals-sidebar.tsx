import { useState } from "react";
import { Link, useLocation } from "wouter";
import { FileText, Globe, Lightbulb, Plus, Bitcoin, User, Settings, LogOut } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarFooter,
  SidebarSeparator,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { AssetLayer } from "../../../../shared/schema";

interface ApiAsset {
  id: string;
  title: string;
  assetType: string;
  status: string;
  createdAt: string;
  currentLayer?: AssetLayer;
  userId?: string;
  didPeer?: string | null;
  didWebvh?: string | null;
}

type TabType = 'ideas' | 'resources' | 'assets';

export function OriginalsSidebar() {
  const [location, navigate] = useLocation();
  const [activeTab, setActiveTab] = useState<TabType>('ideas');
  const [quickTitle, setQuickTitle] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const { isAuthenticated, user, logout } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Fetch assets from API
  const { data: apiAssets } = useQuery<ApiAsset[]>({
    queryKey: ["/api/assets"],
    enabled: isAuthenticated,
  });

  // Filter API assets by layer - only show if authenticated
  const ideasDocs = isAuthenticated && apiAssets ? apiAssets.filter(a => a.currentLayer === 'did:peer') : [];
  const resourcesDocs = isAuthenticated && apiAssets ? apiAssets.filter(a => a.currentLayer === 'did:webvh') : [];
  const assetsDocs = isAuthenticated && apiAssets ? apiAssets.filter(a => a.currentLayer === 'did:btco') : [];

  const createNewAsset = () => {
    navigate('/create');
  };

  const handleQuickCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!quickTitle.trim() || isCreating) return;

    setIsCreating(true);
    try {
      const response = await apiRequest('POST', '/api/assets', {
        title: quickTitle.trim(),
        assetType: 'original',
        content: '',
        metadata: {},
      });

      const result = await response.json();

      // Refresh assets list
      queryClient.invalidateQueries({ queryKey: ["/api/assets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });

      // Clear input
      setQuickTitle('');

      // Navigate to the new asset
      navigate(`/asset/${result.id}`);

      toast({
        title: "Asset created!",
        description: `"${quickTitle}" has been created in did:peer layer`,
      });
    } catch (error: any) {
      console.error('Quick create error:', error);
      toast({
        title: "Failed to create asset",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsCreating(false);
    }
  };

  const tabs = [
    {
      id: 'ideas' as TabType,
      label: 'Ideas',
      icon: Lightbulb,
      count: ideasDocs.length,
      description: 'Private experiments',
      color: 'text-blue-600',
    },
    {
      id: 'resources' as TabType,
      label: 'Resources',
      icon: Globe,
      count: resourcesDocs.length,
      description: 'Published works',
      color: 'text-green-600',
    },
    {
      id: 'assets' as TabType,
      label: 'Assets',
      icon: Bitcoin,
      count: assetsDocs.length,
      description: 'Property on-chain',
      color: 'text-orange-600',
    },
  ];

  const getCurrentDocs = () => {
    switch (activeTab) {
      case 'ideas':
        return ideasDocs;
      case 'resources':
        return resourcesDocs;
      case 'assets':
        return assetsDocs;
      default:
        return [];
    }
  };

  const currentDocs = getCurrentDocs();

  return (
    <Sidebar side="left" variant="sidebar" collapsible="none" className="flex flex-col h-screen">
      <SidebarHeader className="border-b border-gray-200 bg-white p-3 flex-shrink-0">
        <div className="flex items-center justify-between mb-3">
          <button
            onClick={() => navigate("/")}
            className="text-gray-900 font-light text-lg tracking-tight hover:text-gray-700 transition-colors"
          >
            Originals
          </button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            onClick={createNewAsset}
            title="Create new asset"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        <form onSubmit={handleQuickCreate} className="flex gap-2">
          <Input
            type="text"
            placeholder="Type title and press enter..."
            value={quickTitle}
            onChange={(e) => setQuickTitle(e.target.value)}
            disabled={isCreating}
            className="flex-1 text-sm"
          />
        </form>
      </SidebarHeader>

      <SidebarContent className="bg-gray-50 flex-1 flex flex-col overflow-hidden">
        {/* Tab Navigation - Fixed at top */}
        <div className="border-b border-gray-200 bg-white px-3 py-2 flex-shrink-0">
          <div className="flex flex-col gap-1">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;

              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    "flex items-center justify-between w-full px-3 py-2 rounded-md transition-colors text-sm",
                    isActive
                      ? "bg-gray-100 text-gray-900 font-medium"
                      : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Icon className={cn("h-4 w-4", isActive && tab.color)} />
                    <span>{tab.label}</span>
                  </div>
                  <span className={cn(
                    "px-2 py-0.5 rounded-full text-xs",
                    isActive
                      ? "bg-gray-200 text-gray-700"
                      : "bg-gray-100 text-gray-500"
                  )}>
                    {tab.count}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Document List - Scrollable */}
        <div className="flex-1 overflow-y-auto">
          <SidebarGroup>
            <SidebarGroupLabel className="px-4 py-2 text-gray-500">
              {tabs.find(t => t.id === activeTab)?.description}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu className="px-2">
                {currentDocs.length === 0 ? (
                  <div className="px-4 py-6 text-center text-sm text-gray-500">
                    No {activeTab} yet
                  </div>
                ) : (
                  currentDocs.map((asset) => {
                    const href = `/asset/${asset.id}`;
                    const isActive = location === `/asset/${asset.id}`;

                    return (
                      <SidebarMenuItem key={asset.id}>
                        <SidebarMenuButton
                          asChild
                          isActive={isActive}
                          className="px-3 py-2"
                        >
                          <a href={href} onClick={(e) => {
                            e.preventDefault();
                            navigate(href);
                          }}>
                            <FileText className="h-4 w-4 text-gray-400" />
                            <div className="flex-1 min-w-0">
                              <div className="truncate text-sm font-medium text-gray-900">
                                {asset.title || 'Untitled'}
                              </div>
                              <div className="text-xs text-gray-500">
                                {new Date(asset.createdAt).toLocaleDateString()}
                              </div>
                            </div>
                          </a>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </div>
      </SidebarContent>

      <SidebarFooter className="border-t border-gray-200 bg-white flex-shrink-0">
        {isAuthenticated ? (
          <div className="p-2 space-y-1">
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild>
                  <a href="/profile" onClick={(e) => { e.preventDefault(); navigate("/profile"); }}>
                    <div className="flex items-center gap-2 w-full">
                      <div className="w-6 h-6 rounded-full bg-blue-600 text-white flex items-center justify-center text-xs font-medium">
                        {user?.email ? user.email.charAt(0).toUpperCase() : <User className="w-3 h-3" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-gray-900 truncate">
                          {user?.email ? user.email.split('@')[0] : 'User'}
                        </div>
                        <div className="text-xs text-gray-500">View profile</div>
                      </div>
                    </div>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild>
                  <a href="/setup" onClick={(e) => { e.preventDefault(); navigate("/setup"); }}>
                    <Settings className="h-4 w-4" />
                    <span>Setup</span>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </div>
        ) : (
          <div className="p-2">
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild>
                  <a href="/login" onClick={(e) => { e.preventDefault(); navigate("/login"); }}>
                    <User className="h-4 w-4" />
                    <span>Sign In</span>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </div>
        )}
      </SidebarFooter>
    </Sidebar>
  );
}
