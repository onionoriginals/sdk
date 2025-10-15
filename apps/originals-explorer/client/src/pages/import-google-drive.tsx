import { useState, useEffect } from "react";
import { useLocation, Link } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, Loader2, FolderOpen, FileText, CheckCircle, XCircle, ExternalLink } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";

interface GoogleDriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  createdTime?: string;
  modifiedTime?: string;
  webViewLink?: string;
  thumbnailLink?: string;
  iconLink?: string;
}

export default function ImportGoogleDrive() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { user, isAuthenticated } = useAuth();
  
  const [accessToken, setAccessToken] = useState<string>("");
  const [folderId, setFolderId] = useState<string>("");
  const [files, setFiles] = useState<GoogleDriveFile[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [category, setCategory] = useState<string>("document");
  const [importResult, setImportResult] = useState<any>(null);

  // Load access token from Google OAuth (if available)
  useEffect(() => {
    // Check if user is authenticated via Google
    // In production, this would be handled by OAuth flow
    const storedToken = localStorage.getItem('google_access_token');
    if (storedToken) {
      setAccessToken(storedToken);
    }
  }, []);

  // Mutation to list files from Google Drive folder
  const listFilesMutation = useMutation({
    mutationFn: async () => {
      if (!accessToken) {
        throw new Error("Google access token is required");
      }
      
      const response = await apiRequest('POST', '/api/google-drive/list-folder', {
        accessToken,
        folderId: folderId || undefined,
      });
      
      return await response.json();
    },
    onSuccess: (data) => {
      setFiles(data.files || []);
      toast({
        title: "Success",
        description: `Found ${data.count} files in the folder`,
      });
    },
    onError: (error: any) => {
      console.error("Error listing files:", error);
      toast({
        title: "Error",
        description: error.message || "Failed to list files from Google Drive",
        variant: "destructive",
      });
    },
  });

  // Mutation to import selected files
  const importFilesMutation = useMutation({
    mutationFn: async () => {
      if (!accessToken) {
        throw new Error("Google access token is required");
      }
      
      const fileIds = Array.from(selectedFiles);
      
      const response = await apiRequest('POST', '/api/google-drive/import-folder', {
        accessToken,
        folderId: folderId || undefined,
        fileIds: fileIds.length > 0 ? fileIds : undefined,
        category,
      });
      
      return await response.json();
    },
    onSuccess: (data) => {
      setImportResult(data);
      queryClient.invalidateQueries({ 
        predicate: (query) => 
          query.queryKey[0] === "/api/assets" || query.queryKey[0]?.toString().startsWith("/api/assets?")
      });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      
      toast({
        title: "Import Complete",
        description: `Successfully imported ${data.imported} of ${data.total} files`,
      });
      
      // Clear selections
      setSelectedFiles(new Set());
    },
    onError: (error: any) => {
      console.error("Error importing files:", error);
      toast({
        title: "Error",
        description: error.message || "Failed to import files from Google Drive",
        variant: "destructive",
      });
    },
  });

  const handleListFiles = () => {
    setIsLoading(true);
    setFiles([]);
    setSelectedFiles(new Set());
    listFilesMutation.mutate();
    setIsLoading(false);
  };

  const handleImport = () => {
    if (selectedFiles.size === 0 && files.length === 0) {
      toast({
        title: "No files selected",
        description: "Please select files to import or list files from a folder first",
        variant: "destructive",
      });
      return;
    }
    
    setIsImporting(true);
    importFilesMutation.mutate();
    setIsImporting(false);
  };

  const toggleFileSelection = (fileId: string) => {
    const newSelection = new Set(selectedFiles);
    if (newSelection.has(fileId)) {
      newSelection.delete(fileId);
    } else {
      newSelection.add(fileId);
    }
    setSelectedFiles(newSelection);
  };

  const selectAll = () => {
    if (selectedFiles.size === files.length) {
      setSelectedFiles(new Set());
    } else {
      setSelectedFiles(new Set(files.map(f => f.id)));
    }
  };

  // Initiate Google OAuth flow
  const handleConnectGoogle = () => {
    // In production, this would redirect to Google OAuth
    // For now, we'll show instructions
    toast({
      title: "Google Drive Connection",
      description: "Please obtain a Google access token with Drive API access and paste it below.",
    });
  };

  if (!isAuthenticated) {
    return (
      <main className="max-w-4xl mx-auto px-8 py-16">
        <div className="bg-white border border-gray-200 rounded-sm p-8 text-center">
          <h1 className="text-2xl font-light mb-4">Authentication Required</h1>
          <p className="text-gray-500 mb-6">Please sign in to import from Google Drive.</p>
          <Button onClick={() => setLocation("/login?returnTo=/import-google-drive")}>
            Sign In
          </Button>
        </div>
      </main>
    );
  }

  return (
    <main className="max-w-4xl mx-auto px-8 py-16">
      <button 
        onClick={() => setLocation("/")}
        className="text-gray-500 hover:text-gray-700 text-sm mb-12 flex items-center transition-colors"
      >
        <ArrowLeft className="mr-2 w-4 h-4" />
        Back
      </button>

      <h1 className="page-title">Import from Google Drive</h1>
      <p className="text-gray-500 mb-8">
        Select a Google Drive folder and import all resources as did:peer assets.
      </p>

      <div className="space-y-6">
        {/* Google Access Token */}
        <div className="bg-white border border-gray-200 rounded-sm p-6">
          <h2 className="text-lg font-medium mb-4">Google Drive Connection</h2>
          
          {!accessToken ? (
            <div className="space-y-4">
              <p className="text-sm text-gray-600">
                To import files from Google Drive, you need to provide an access token.
              </p>
              <div className="space-y-2">
                <label className="text-sm font-medium text-gray-700">Access Token</label>
                <Input
                  type="password"
                  placeholder="Paste your Google access token here"
                  value={accessToken}
                  onChange={(e) => {
                    setAccessToken(e.target.value);
                    localStorage.setItem('google_access_token', e.target.value);
                  }}
                  className="border-gray-200 focus:border-gray-400 rounded-sm"
                />
              </div>
              <Button onClick={handleConnectGoogle} variant="outline">
                How to Get Access Token
              </Button>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-green-600">
                <CheckCircle className="w-5 h-5" />
                <span className="text-sm font-medium">Connected to Google Drive</span>
              </div>
              <Button 
                variant="outline" 
                size="sm"
                onClick={() => {
                  setAccessToken("");
                  localStorage.removeItem('google_access_token');
                }}
              >
                Disconnect
              </Button>
            </div>
          )}
        </div>

        {/* Folder Selection */}
        {accessToken && (
          <div className="bg-white border border-gray-200 rounded-sm p-6">
            <h2 className="text-lg font-medium mb-4">Select Folder</h2>
            
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium text-gray-700">
                  Folder ID (optional - leave empty for root)
                </label>
                <Input
                  placeholder="Google Drive folder ID"
                  value={folderId}
                  onChange={(e) => setFolderId(e.target.value)}
                  className="border-gray-200 focus:border-gray-400 rounded-sm"
                />
                <p className="text-xs text-gray-500">
                  You can find the folder ID in the URL when viewing a folder in Google Drive
                </p>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-gray-700">Category</label>
                <Select value={category} onValueChange={setCategory}>
                  <SelectTrigger className="border-gray-200 focus:border-gray-400 rounded-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="art">Art</SelectItem>
                    <SelectItem value="music">Music</SelectItem>
                    <SelectItem value="video">Video</SelectItem>
                    <SelectItem value="document">Document</SelectItem>
                    <SelectItem value="collectible">Collectible</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <Button 
                onClick={handleListFiles}
                disabled={isLoading || listFilesMutation.isPending}
                className="w-full"
              >
                {(isLoading || listFilesMutation.isPending) ? (
                  <>
                    <Loader2 className="mr-2 w-4 h-4 animate-spin" />
                    Loading Files...
                  </>
                ) : (
                  <>
                    <FolderOpen className="mr-2 w-4 h-4" />
                    List Files
                  </>
                )}
              </Button>
            </div>
          </div>
        )}

        {/* File List */}
        {files.length > 0 && (
          <div className="bg-white border border-gray-200 rounded-sm p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-medium">Files ({files.length})</h2>
              <Button variant="outline" size="sm" onClick={selectAll}>
                {selectedFiles.size === files.length ? "Deselect All" : "Select All"}
              </Button>
            </div>

            <div className="space-y-2 max-h-96 overflow-y-auto">
              {files.map((file) => (
                <div
                  key={file.id}
                  className="flex items-center gap-3 p-3 border border-gray-200 rounded-sm hover:bg-gray-50 transition-colors"
                >
                  <Checkbox
                    checked={selectedFiles.has(file.id)}
                    onCheckedChange={() => toggleFileSelection(file.id)}
                  />
                  {file.thumbnailLink ? (
                    <img 
                      src={file.thumbnailLink} 
                      alt={file.name}
                      className="w-10 h-10 object-cover rounded"
                    />
                  ) : file.iconLink ? (
                    <img 
                      src={file.iconLink} 
                      alt={file.name}
                      className="w-10 h-10"
                    />
                  ) : (
                    <FileText className="w-10 h-10 text-gray-400" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{file.name}</p>
                    <p className="text-xs text-gray-500">
                      {file.mimeType} 
                      {file.size && ` • ${(parseInt(file.size) / 1024 / 1024).toFixed(2)} MB`}
                    </p>
                  </div>
                  {file.webViewLink && (
                    <a
                      href={file.webViewLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-gray-400 hover:text-gray-600"
                    >
                      <ExternalLink className="w-4 h-4" />
                    </a>
                  )}
                </div>
              ))}
            </div>

            <div className="mt-6 pt-6 border-t border-gray-200">
              <Button 
                onClick={handleImport}
                disabled={isImporting || importFilesMutation.isPending}
                className="w-full"
              >
                {(isImporting || importFilesMutation.isPending) ? (
                  <>
                    <Loader2 className="mr-2 w-4 h-4 animate-spin" />
                    Importing...
                  </>
                ) : (
                  <>
                    Import {selectedFiles.size > 0 ? `${selectedFiles.size} Selected` : "All"} Files
                  </>
                )}
              </Button>
            </div>
          </div>
        )}

        {/* Import Results */}
        {importResult && (
          <div className="bg-green-50 border border-green-200 rounded-sm p-6">
            <div className="flex items-center gap-2 mb-4">
              <CheckCircle className="w-5 h-5 text-green-600" />
              <h3 className="font-medium text-green-900">Import Complete</h3>
            </div>
            
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-green-700">Total Files:</span>
                <span className="font-medium text-green-900">{importResult.total}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-green-700">Successfully Imported:</span>
                <span className="font-medium text-green-900">{importResult.imported}</span>
              </div>
              {importResult.failed > 0 && (
                <div className="flex justify-between">
                  <span className="text-red-700">Failed:</span>
                  <span className="font-medium text-red-900">{importResult.failed}</span>
                </div>
              )}
            </div>

            {importResult.errors && importResult.errors.length > 0 && (
              <details className="mt-4">
                <summary className="text-sm text-red-600 cursor-pointer">View Errors</summary>
                <div className="mt-2 space-y-1">
                  {importResult.errors.map((error: any, idx: number) => (
                    <div key={idx} className="text-xs text-red-700 bg-white p-2 rounded">
                      <span className="font-medium">{error.fileName}:</span> {error.error}
                    </div>
                  ))}
                </div>
              </details>
            )}

            <div className="flex gap-3 mt-4">
              <Link href="/dashboard">
                <Button size="sm" variant="outline">View Dashboard</Button>
              </Link>
              <Button 
                size="sm" 
                variant="outline"
                onClick={() => {
                  setImportResult(null);
                  setFiles([]);
                  setSelectedFiles(new Set());
                }}
              >
                Import More Files
              </Button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
