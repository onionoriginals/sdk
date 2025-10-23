import { useState, useEffect } from "react";
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
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { useQuery } from "@tanstack/react-query";
import type { AssetLayer } from "../../../../../shared/schema";

interface Document {
  id: string;
  title: string;
  content: string;
  updatedAt: string;
  layer: 'private' | 'public' | 'property';
}

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
  const [documents, setDocuments] = useState<Document[]>([]);
  const { isAuthenticated, user, logout } = useAuth();

  // Fetch assets from API
  const { data: apiAssets } = useQuery<ApiAsset[]>({
    queryKey: ["/api/assets"],
    enabled: isAuthenticated,
  });

  useEffect(() => {
    const loadDocuments = () => {
      const saved = localStorage.getItem("originals-documents");
      const docs: Document[] = saved ? JSON.parse(saved) : [];
      setDocuments(docs);
    };

    loadDocuments();
    window.addEventListener('originals-documents-updated', loadDocuments);

    return () => {
      window.removeEventListener('originals-documents-updated', loadDocuments);
    };
  }, []);

  // Combine localStorage documents with API assets
  const ideasDocs = [
    ...documents.filter(d => (d.layer || 'private') === 'private').map(d => ({ ...d, isApiAsset: false })),
    ...(apiAssets?.filter(a => a.currentLayer === 'private').map(a => ({
      id: a.id,
      title: a.title,
      content: '',
      updatedAt: a.createdAt,
      layer: 'private' as const,
      isApiAsset: true,
    })) || [])
  ];

  const resourcesDocs = [
    ...documents.filter(d => (d.layer || 'private') === 'public').map(d => ({ ...d, isApiAsset: false })),
    ...(apiAssets?.filter(a => a.currentLayer === 'public').map(a => ({
      id: a.id,
      title: a.title,
      content: '',
      updatedAt: a.createdAt,
      layer: 'public' as const,
      isApiAsset: true,
    })) || [])
  ];

  const assetsDocs = [
    ...documents.filter(d => (d.layer || 'private') === 'property').map(d => ({ ...d, isApiAsset: false })),
    ...(apiAssets?.filter(a => a.currentLayer === 'property').map(a => ({
      id: a.id,
      title: a.title,
      content: '',
      updatedAt: a.createdAt,
      layer: 'property' as const,
      isApiAsset: true,
    })) || [])
  ];

  const createNewDocument = () => {
    const newDoc: Document = {
      id: Math.random().toString(36).substring(2, 11),
      title: 'Untitled',
      content: '',
      updatedAt: new Date().toISOString(),
      layer: 'private',
    };

    const allDocs = [...documents, newDoc];
    localStorage.setItem("originals-documents", JSON.stringify(allDocs));
    window.dispatchEvent(new Event('originals-documents-updated'));
    navigate(`/?doc=${newDoc.id}`);
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
      description: 'On-chain property',
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
  const urlParams = new URLSearchParams(window.location.search);
  const activeDocId = urlParams.get('doc');

  return (
    <Sidebar side="left" variant="sidebar" collapsible="none">
      <SidebarHeader className="border-b border-gray-200 bg-white p-3">
        <div className="flex items-center justify-between">
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
            onClick={createNewDocument}
            title="Create new document"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </SidebarHeader>

      <SidebarContent className="bg-gray-50">
        {/* Tab Navigation */}
        <div className="border-b border-gray-200 bg-white px-3 py-2">
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

        {/* Document List */}
        <SidebarGroup className="flex-1 overflow-hidden">
          <SidebarGroupLabel className="px-4 py-2 text-gray-500">
            {tabs.find(t => t.id === activeTab)?.description}
          </SidebarGroupLabel>
          <SidebarGroupContent className="overflow-y-auto">
            <SidebarMenu className="px-2">
              {currentDocs.length === 0 ? (
                <div className="px-4 py-6 text-center text-sm text-gray-500">
                  No {activeTab} yet
                </div>
              ) : (
                currentDocs.map((doc) => {
                  const href = (doc as any).isApiAsset ? `/dashboard` : `/?doc=${doc.id}`;
                  return (
                    <SidebarMenuItem key={doc.id}>
                      <SidebarMenuButton
                        asChild
                        isActive={activeDocId === doc.id}
                        className="px-3 py-2"
                      >
                        <a href={href} onClick={(e) => {
                          e.preventDefault();
                          navigate(href);
                        }}>
                          <FileText className="h-4 w-4 text-gray-400" />
                          <div className="flex-1 min-w-0">
                            <div className="truncate text-sm font-medium text-gray-900">
                              {doc.title || 'Untitled'}
                            </div>
                            <div className="text-xs text-gray-500">
                              {new Date(doc.updatedAt).toLocaleDateString()}
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
      </SidebarContent>

      <SidebarFooter className="border-t border-gray-200 bg-white">
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
