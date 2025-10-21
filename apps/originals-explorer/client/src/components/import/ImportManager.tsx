import { useState, useEffect, useRef } from 'react';
import { Button } from '../ui/button';
import { useToast } from '@/hooks/use-toast';
import { useGoogleAuth } from '@/hooks/useGoogleAuth';
import { FolderOpen, LogOut } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Alert, AlertDescription } from '../ui/alert';
import { Checkbox } from '../ui/checkbox';
import { ScrollArea } from '../ui/scroll-area';
import { Loader2, Image, CheckCircle2 } from 'lucide-react';
import { ImportProgress } from './ImportProgress';

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  thumbnailLink?: string;
}

interface ImportManagerProps {
  userId: string | null;
  onImportComplete?: () => void;
}

export function ImportManager({ userId, onImportComplete }: ImportManagerProps) {
  const { accessToken, isAuthenticated, isLoading, error: authError, login, logout } = useGoogleAuth();
  
  // Step 1: Folder selection from Google Picker (no modal)
  const [loadingFolder, setLoadingFolder] = useState(false);
  
  // Step 2: File selection modal (after picker closes)
  const [showFileSelection, setShowFileSelection] = useState(false);
  const [folderData, setFolderData] = useState<{
    folderId: string;
    folderName: string;
    files: DriveFile[];
  } | null>(null);
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set());
  
  // Step 3: Import progress
  const [importId, setImportId] = useState<string | null>(null);
  const [showProgress, setShowProgress] = useState(false);
  
  // Track Google Picker API loading state
  const [pickerApiLoaded, setPickerApiLoaded] = useState(false);
  const pickerLoadingRef = useRef(false);
  
  const { toast } = useToast();

  // Debug: Log auth state changes
  useEffect(() => {
    console.log('[ImportManager] Auth state:', { 
      isAuthenticated, 
      isLoading, 
      hasToken: !!accessToken,
      authError 
    });
  }, [isAuthenticated, isLoading, accessToken, authError]);

  // Auto-open picker if returning from OAuth
  useEffect(() => {
    const shouldOpenPicker = sessionStorage.getItem('google_auth_should_open_picker');
    
    if (shouldOpenPicker === 'true' && isAuthenticated && pickerApiLoaded && accessToken) {
      console.log('[ImportManager] Auto-opening picker after OAuth return');
      
      // Clear the flag
      sessionStorage.removeItem('google_auth_should_open_picker');
      
      // Small delay to ensure everything is ready
      setTimeout(() => {
        const apiKey = import.meta.env.VITE_GOOGLE_API_KEY;
        if (apiKey) {
          openPicker(accessToken, apiKey);
        } else {
          toast({
            title: 'Configuration Error',
            description: 'Google API Key not configured',
            variant: 'destructive',
          });
        }
      }, 300);
    }
  }, [isAuthenticated, pickerApiLoaded, accessToken, toast]);

  // Preload Google Picker API when authenticated
  useEffect(() => {
    console.log('[ImportManager] Picker API effect triggered:', { 
      isAuthenticated, 
      pickerApiLoaded, 
      isLoadingRef: pickerLoadingRef.current 
    });

    if (!isAuthenticated || pickerApiLoaded || pickerLoadingRef.current) {
      return;
    }

    // Check if already loaded
    if ((window as any).google?.picker) {
      console.log('[ImportManager] Google Picker already loaded');
      setPickerApiLoaded(true);
      return;
    }

    // Mark as loading to prevent duplicate loads
    pickerLoadingRef.current = true;
    console.log('[ImportManager] Starting to load Google Picker API...');

    // Check if gapi script is already in DOM
    const existingScript = document.querySelector('script[src="https://apis.google.com/js/api.js"]');
    
    if (existingScript) {
      // Script exists, just load the picker module
      if ((window as any).gapi) {
        (window as any).gapi.load('picker', {
          callback: () => {
            console.log('[ImportManager] Google Picker loaded successfully (existing script, gapi available)');
            setPickerApiLoaded(true);
            pickerLoadingRef.current = false;
          },
          onerror: () => {
            console.error('[ImportManager] Failed to load Google Picker module');
            pickerLoadingRef.current = false;
          },
        });
      } else {
        // Wait for gapi to be available
        console.log('[ImportManager] Waiting for gapi to be available...');
        existingScript.addEventListener('load', () => {
          (window as any).gapi.load('picker', {
            callback: () => {
              console.log('[ImportManager] Google Picker loaded successfully (after script load)');
              setPickerApiLoaded(true);
              pickerLoadingRef.current = false;
            },
            onerror: () => {
              console.error('[ImportManager] Failed to load Google Picker module');
              pickerLoadingRef.current = false;
            },
          });
        });
      }
      return;
    }

    // Load the script
    const script = document.createElement('script');
    script.src = 'https://apis.google.com/js/api.js';
    script.async = true;
    script.defer = true;
    
    script.onload = () => {
      console.log('[ImportManager] Google API script loaded, loading picker module...');
      (window as any).gapi.load('picker', {
        callback: () => {
          console.log('[ImportManager] ✅ Google Picker loaded successfully (new script)');
          setPickerApiLoaded(true);
          pickerLoadingRef.current = false;
        },
        onerror: () => {
          console.error('[ImportManager] ❌ Failed to load Google Picker module');
          toast({
            title: 'Error',
            description: 'Failed to load Google Picker. Please refresh the page.',
            variant: 'destructive',
          });
          pickerLoadingRef.current = false;
        },
      });
    };
    
    script.onerror = () => {
      console.error('[ImportManager] ❌ Failed to load Google API script');
      toast({
        title: 'Error',
        description: 'Failed to load Google API. Please check your internet connection.',
        variant: 'destructive',
      });
      pickerLoadingRef.current = false;
    };
    
    document.body.appendChild(script);
  }, [isAuthenticated, pickerApiLoaded, toast]);

  const handleOpenPicker = () => {
    if (!accessToken) {
      toast({
        title: 'Error',
        description: 'Please connect your Google account first',
        variant: 'destructive',
      });
      return;
    }

    const apiKey = import.meta.env.VITE_GOOGLE_API_KEY;
    
    if (!apiKey) {
      toast({
        title: 'Configuration Error',
        description: 'Google API Key not configured',
        variant: 'destructive',
      });
      return;
    }

    if (!pickerApiLoaded) {
      toast({
        title: 'Please Wait',
        description: 'Google Picker is still loading...',
      });
      return;
    }

    // Open Google Picker
    openPicker(accessToken, apiKey);
  };

  const openPicker = (token: string, apiKey: string) => {
    try {
      console.log('Opening Google Picker with token and API key');
      
      if (!(window as any).google?.picker) {
        throw new Error('Google Picker API not loaded');
      }

      const docsView = new (window as any).google.picker.DocsView()
        .setIncludeFolders(true)
        .setSelectFolderEnabled(true)
        .setMimeTypes('application/vnd.google-apps.folder');

      const picker = new (window as any).google.picker.PickerBuilder()
        .addView(docsView)
        .setOAuthToken(token)
        .setDeveloperKey(apiKey)
        .setCallback((data: any) => {
          if (data.action === (window as any).google.picker.Action.PICKED) {
            const folder = data.docs[0];
            console.log('Folder selected in picker:', folder.name);
            // Picker will auto-close, then we fetch files
            handleFolderPicked(folder.id, folder.name);
          }
        })
        .build();
      
      picker.setVisible(true);
      console.log('Picker should now be visible');
    } catch (err: any) {
      console.error('Error opening picker:', err);
      toast({
        title: 'Error',
        description: err.message || 'Failed to open Google Drive picker',
        variant: 'destructive',
      });
    }
  };

  const handleFolderPicked = async (folderId: string, folderName: string) => {
    setLoadingFolder(true);

    try {
      console.log('Fetching files from folder:', folderId);
      
      const response = await fetch('/api/import/google-drive/list-files', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          folderId,
          accessToken,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to list files');
      }

      if (data.totalFiles === 0) {
        toast({
          title: 'No Images Found',
          description: 'This folder contains no image files',
          variant: 'destructive',
        });
        setLoadingFolder(false);
        return;
      }

      const files: DriveFile[] = data.files || [];
      console.log('Files fetched, auto-starting import for', files.length, 'files');
      
      // Automatically start import with all files (skip selection modal)
      await startImportWithFiles(folderId, data.folderName || folderName, files);
    } catch (err: any) {
      toast({
        title: 'Error',
        description: err.message || 'Failed to access folder',
        variant: 'destructive',
      });
      setLoadingFolder(false);
    }
  };

  const startImportWithFiles = async (folderId: string, folderName: string, files: DriveFile[]) => {
    console.log('[ImportManager] startImportWithFiles called with', files.length, 'files');
    
    if (!userId) {
      console.error('[ImportManager] No userId found');
      toast({
        title: 'Error',
        description: 'User not found',
        variant: 'destructive',
      });
      setLoadingFolder(false);
      return;
    }

    try {
      // Extract file IDs
      const fileIds = files.map(f => f.id);
      console.log('[ImportManager] Starting import with fileIds:', fileIds.length);
      
      const response = await fetch('/api/import/google-drive/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId,
          folderId,
          folderName,
          accessToken,
          fileIds, // Send only IDs
        }),
      });

      console.log('[ImportManager] Response status:', response.status);
      const data = await response.json();
      console.log('[ImportManager] Response data:', data);

      if (!response.ok) {
        throw new Error(data.error || 'Failed to start import');
      }

      console.log('[ImportManager] Setting import ID and showing progress:', data.importId);
      setImportId(data.importId);
      setShowProgress(true);
      setLoadingFolder(false);

      toast({
        title: 'Import Started',
        description: `Importing ${files.length} image${files.length !== 1 ? 's' : ''}`,
      });
    } catch (error: any) {
      console.error('[ImportManager] Import failed:', error);
      toast({
        title: 'Import Failed',
        description: error.message || 'Failed to start import',
        variant: 'destructive',
      });
      setLoadingFolder(false);
    }
  };

  const handleToggleFile = (fileId: string) => {
    const newSelected = new Set(selectedFileIds);
    if (newSelected.has(fileId)) {
      newSelected.delete(fileId);
    } else {
      newSelected.add(fileId);
    }
    setSelectedFileIds(newSelected);
  };

  const handleSelectAll = () => {
    if (folderData) {
      setSelectedFileIds(new Set(folderData.files.map(f => f.id)));
    }
  };

  const handleSelectNone = () => {
    setSelectedFileIds(new Set());
  };

  const handleStartImport = async () => {
    if (!userId || !folderData) return;

    const filesToImport = folderData.files.filter(f => selectedFileIds.has(f.id));
    
    if (filesToImport.length === 0) {
      toast({
        title: 'No Files Selected',
        description: 'Please select at least one file to import',
        variant: 'destructive',
      });
      return;
    }

    try {
      // Only send file IDs to reduce request size
      const fileIds = filesToImport.map(f => f.id);
      
      const response = await fetch('/api/import/google-drive/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId,
          folderId: folderData.folderId,
          folderName: folderData.folderName,
          accessToken,
          fileIds, // Send only IDs, not full file objects
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to start import');
      }

      setImportId(data.importId);
      setShowFileSelection(false);
      setShowProgress(true);

      toast({
        title: 'Import Started',
        description: `Importing ${filesToImport.length} image${filesToImport.length !== 1 ? 's' : ''}`,
      });
    } catch (error: any) {
      toast({
        title: 'Import Failed',
        description: error.message || 'Failed to start import',
        variant: 'destructive',
      });
    }
  };

  const handleImportComplete = () => {
    setShowProgress(false);
    setImportId(null);
    setFolderData(null);
    setSelectedFileIds(new Set());

    toast({
      title: 'Import Complete',
      description: 'Your images have been imported successfully',
    });

    if (onImportComplete) {
      onImportComplete();
    }
  };

  // Show auth error if present
  if (authError) {
    return (
      <Button variant="outline" disabled className="gap-2">
        <FolderOpen className="h-4 w-4" />
        {authError}
      </Button>
    );
  }

  // Show loading state
  if (isLoading) {
    return (
      <Button variant="outline" disabled className="gap-2">
        <FolderOpen className="h-4 w-4" />
        Loading...
      </Button>
    );
  }

  // Show login button if not authenticated
  if (!isAuthenticated) {
    return (
      <Button
        onClick={login}
        variant="outline"
        className="gap-2"
      >
        <FolderOpen className="h-4 w-4" />
        Connect Google Drive
      </Button>
    );
  }

  // Show import button when authenticated
  return (
    <>
      <div className="flex gap-2">
        <Button
          onClick={handleOpenPicker}
          variant="outline"
          className="gap-2"
          disabled={loadingFolder || !pickerApiLoaded}
        >
          {loadingFolder ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading folder...
            </>
          ) : !pickerApiLoaded ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading Picker...
            </>
          ) : (
            <>
              <FolderOpen className="h-4 w-4" />
              Import from Google Drive
            </>
          )}
        </Button>
        
        <Button
          onClick={logout}
          variant="ghost"
          size="sm"
          className="gap-2"
          title="Disconnect Google Drive"
        >
          <LogOut className="h-3 w-3" />
        </Button>
      </div>

      {/* File Selection Modal - shows AFTER picker closes */}
      {showFileSelection && folderData && (
        <Dialog open={showFileSelection} onOpenChange={setShowFileSelection}>
          <DialogContent className="sm:max-w-[700px] max-h-[90vh] flex flex-col">
            <DialogHeader>
              <DialogTitle>Select Images to Import</DialogTitle>
              <DialogDescription>
                Choose which images from "{folderData.folderName}" to import
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 flex-1 overflow-hidden">
              {/* Folder Info Header */}
              <div className="rounded-lg border p-4 bg-muted/50">
                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <h4 className="font-semibold">{folderData.folderName}</h4>
                    <div className="flex items-center text-sm text-muted-foreground">
                      <Image className="mr-1 h-4 w-4" />
                      {folderData.files.length} image{folderData.files.length !== 1 ? 's' : ''} found • {selectedFileIds.size} selected
                    </div>
                  </div>
                </div>
              </div>

              {/* Select All/None Controls */}
              <div className="flex items-center justify-between px-1">
                <span className="text-sm font-medium">Select images:</span>
                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleSelectAll}
                    disabled={selectedFileIds.size === folderData.files.length}
                  >
                    Select All
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleSelectNone}
                    disabled={selectedFileIds.size === 0}
                  >
                    Clear
                  </Button>
                </div>
              </div>

              {/* File List */}
              <ScrollArea className="h-[400px] rounded-md border flex-shrink-0">
                <div className="p-4 space-y-2">
                  {folderData.files.map((file) => (
                    <div
                      key={file.id}
                      className="flex items-center space-x-3 p-2 rounded hover:bg-muted/50 cursor-pointer"
                      onClick={() => handleToggleFile(file.id)}
                    >
                      <Checkbox
                        checked={selectedFileIds.has(file.id)}
                        onCheckedChange={() => handleToggleFile(file.id)}
                      />
                      <div className="w-10 h-10 bg-gradient-to-br from-blue-100 to-purple-100 rounded flex items-center justify-center flex-shrink-0">
                        <Image className="w-5 h-5 text-blue-600" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{file.name}</p>
                        <p className="text-xs text-muted-foreground">{file.mimeType.replace('image/', '').toUpperCase()}</p>
                      </div>
                      {selectedFileIds.has(file.id) && (
                        <CheckCircle2 className="h-4 w-4 text-green-600 flex-shrink-0" />
                      )}
                    </div>
                  ))}
                </div>
              </ScrollArea>

              {/* Import Summary */}
              <Alert>
                <AlertDescription>
                  Will import {selectedFileIds.size} of {folderData.files.length} images
                  {selectedFileIds.size > 0 && ` • Est. time: ~${Math.ceil(selectedFileIds.size * 0.5 / 60)} min`}
                </AlertDescription>
              </Alert>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setShowFileSelection(false)}>
                Cancel
              </Button>
              <Button onClick={handleStartImport} disabled={selectedFileIds.size === 0}>
                Start Import ({selectedFileIds.size})
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Import Progress Modal */}
      {showProgress && importId && (
        <ImportProgress
          importId={importId}
          isOpen={showProgress}
          onComplete={handleImportComplete}
        />
      )}
    </>
  );
}
