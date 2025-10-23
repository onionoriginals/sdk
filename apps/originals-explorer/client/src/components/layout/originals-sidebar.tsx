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

interface Document {
  id: string;
  title: string;
  content: string;
  updatedAt: string;
  layer: 'private' | 'public' | 'property';
}

type TabType = 'ideas' | 'resources' | 'assets';

export function OriginalsSidebar() {
  const [location, navigate] = useLocation();
  const [activeTab, setActiveTab] = useState<TabType>('ideas');
  const [documents, setDocuments] = useState<Document[]>([]);
  const { isAuthenticated, user, logout } = useAuth();

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

  const ideasDocs = documents.filter(d => (d.layer || 'private') === 'private');
  const resourcesDocs = documents.filter(d => (d.layer || 'private') === 'public');
  const assetsDocs = documents.filter(d => (d.layer || 'private') === 'property');

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
        <div className="border-b border-gray-200 bg-white px-2 py-2">
          <div className="flex gap-1">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;

              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    "flex-1 flex flex-col items-center gap-1 px-2 py-2 rounded-md transition-colors text-xs",
                    isActive
                      ? "bg-gray-100 text-gray-900"
                      : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
                  )}
                >
                  <Icon className={cn("h-4 w-4", isActive && tab.color)} />
                  <span className="font-medium">{tab.label}</span>
                  <span className="text-[10px] text-gray-500">{tab.count}</span>
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
                currentDocs.map((doc) => (
                  <SidebarMenuItem key={doc.id}>
                    <SidebarMenuButton
                      asChild
                      isActive={activeDocId === doc.id}
                      className="px-3 py-2"
                    >
                      <Link href={`/?doc=${doc.id}`}>
                        <FileText className="h-4 w-4 text-gray-400" />
                        <div className="flex-1 min-w-0">
                          <div className="truncate text-sm font-medium text-gray-900">
                            {doc.title || 'Untitled'}
                          </div>
                          <div className="text-xs text-gray-500">
                            {new Date(doc.updatedAt).toLocaleDateString()}
                          </div>
                        </div>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))
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
                  <Link href="/profile">
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
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild>
                  <Link href="/setup">
                    <Settings className="h-4 w-4" />
                    <span>Setup</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </div>
        ) : (
          <div className="p-2">
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild>
                  <Link href="/login">
                    <User className="h-4 w-4" />
                    <span>Sign In</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </div>
        )}
      </SidebarFooter>
    </Sidebar>
  );
}
