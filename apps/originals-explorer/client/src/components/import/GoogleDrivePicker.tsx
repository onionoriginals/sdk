import { useState, useEffect } from 'react';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Alert, AlertDescription } from '../ui/alert';
import { Checkbox } from '../ui/checkbox';
import { ScrollArea } from '../ui/scroll-area';
import { Loader2, FolderOpen, Image, CheckCircle2 } from 'lucide-react';

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  thumbnailLink?: string;
}

interface GoogleDrivePickerProps {
  isOpen: boolean;
  onClose: () => void;
  onFolderSelected: (folderId: string, folderName: string, files: DriveFile[]) => void;
  accessToken: string | null;
}

export function GoogleDrivePicker({
  isOpen,
  onClose,
  onFolderSelected,
  accessToken,
}: GoogleDrivePickerProps) {
  const [selectedFolder, setSelectedFolder] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [availableFiles, setAvailableFiles] = useState<DriveFile[]>([]);
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerInstance, setPickerInstance] = useState<any>(null);

  // Track component lifecycle
  useEffect(() => {
    console.log('GoogleDrivePicker mounted, isOpen:', isOpen);
    return () => {
      console.log('GoogleDrivePicker UNMOUNTING - this will lose all state!');
    };
  }, []);

  // Track isOpen changes
  useEffect(() => {
    console.log('isOpen changed to:', isOpen);
  }, [isOpen]);

  const handleOpenPicker = () => {
    if (!accessToken) {
      setError('Please connect your Google account first');
      return;
    }

    const apiKey = import.meta.env.VITE_GOOGLE_API_KEY;
    
    if (!apiKey) {
      setError('Google API Key not configured. Please add VITE_GOOGLE_API_KEY to .env.local');
      return;
    }

    // Check if Google Picker script is already loaded
    if ((window as any).google?.picker) {
      createAndShowPicker(accessToken, apiKey);
      return;
    }

    // Load the Google Picker API
    const script = document.createElement('script');
    script.src = 'https://apis.google.com/js/api.js';
    script.onload = () => {
      (window as any).gapi.load('picker', () => {
        createAndShowPicker(accessToken, apiKey);
      });
    };
    script.onerror = () => {
      setError('Failed to load Google Picker. Please check your internet connection.');
    };
    document.body.appendChild(script);
  };

  const createAndShowPicker = (token: string, apiKey: string) => {
    try {
      // Create a DocsView configured to show and select folders
      const docsView = new (window as any).google.picker.DocsView()
        .setIncludeFolders(true)
        .setSelectFolderEnabled(true)
        .setMimeTypes('application/vnd.google-apps.folder');

      const picker = new (window as any).google.picker.PickerBuilder()
        .addView(docsView)
        .setOAuthToken(token)
        .setDeveloperKey(apiKey)
        .setCallback((data: any) => {
          console.log('Picker callback - action:', data.action);
          if (data.action === (window as any).google.picker.Action.PICKED) {
            const folder = data.docs[0];
            console.log('Folder picked:', folder.name, folder.id);
            // Close the picker immediately
            picker.setVisible(false);
            // Then handle the folder selection
            handleFolderSelected(folder.id, folder.name);
          } else if (data.action === (window as any).google.picker.Action.CANCEL) {
            console.log('Picker cancelled');
            picker.setVisible(false);
          }
        })
        .build();
      
      setPickerInstance(picker);
      picker.setVisible(true);
    } catch (err: any) {
      console.error('Error creating picker:', err);
      setError(`Failed to open Google Drive picker: ${err.message}`);
    }
  };

  const handleFolderSelected = async (folderId: string, folderName: string) => {
    setLoading(true);
    setError(null);

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

      console.log('Response received:', response.status);
      const data = await response.json();
      console.log('Data received:', data);

      if (!response.ok) {
        throw new Error(data.error || 'Failed to list files');
      }

      if (data.totalFiles === 0) {
        setError('No image files found in this folder');
        setLoading(false);
        return;
      }

      // Store files and select all by default
      const files: DriveFile[] = data.files || [];
      console.log('Setting files:', files.length);
      console.log('Sample file:', files[0]);
      
      const newSelectedIds = new Set(files.map((f: DriveFile) => f.id));
      console.log('New selected IDs size:', newSelectedIds.size);
      
      setAvailableFiles(files);
      setSelectedFileIds(newSelectedIds);
      setSelectedFolder({
        id: folderId,
        name: folderName || data.folderName,
      });
      
      console.log('State set calls completed');
      
      // Force a re-render check
      setTimeout(() => {
        console.log('Checking state after timeout...');
        console.log('availableFiles.length would be:', files.length);
      }, 100);
    } catch (err: any) {
      console.error('Error in handleFolderSelected:', err);
      setError(err.message || 'Failed to access folder');
    } finally {
      setLoading(false);
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
    setSelectedFileIds(new Set(availableFiles.map(f => f.id)));
  };

  const handleSelectNone = () => {
    setSelectedFileIds(new Set());
  };

  const handleConfirm = () => {
    if (selectedFolder && selectedFileIds.size > 0) {
      const filesToImport = availableFiles.filter(f => selectedFileIds.has(f.id));
      onFolderSelected(selectedFolder.id, selectedFolder.name, filesToImport);
    }
  };

  const handleReset = () => {
    setSelectedFolder(null);
    setAvailableFiles([]);
    setSelectedFileIds(new Set());
    setError(null);
  };

  // Debug logging
  console.log('GoogleDrivePicker Render state:', {
    isOpen,
    loading,
    hasSelectedFolder: !!selectedFolder,
    selectedFolderName: selectedFolder?.name,
    filesCount: availableFiles.length,
    selectedCount: selectedFileIds.size,
    hasError: !!error,
  });

  return (
    <Dialog open={isOpen} onOpenChange={(open) => {
      console.log('Dialog onOpenChange called with:', open);
      // Only allow manual close from Cancel button, not from outside clicks
      if (!open && !loading) {
        onClose();
      }
    }}>
      <DialogContent className="sm:max-w-[600px]" onPointerDownOutside={(e) => {
        console.log('Clicked outside dialog');
        // Prevent closing when clicking outside
        e.preventDefault();
      }} onEscapeKeyDown={(e) => {
        console.log('Escape key pressed');
        if (loading) {
          // Don't allow escape during loading
          e.preventDefault();
        }
      }}>
        <DialogHeader>
          <DialogTitle>Import from Google Drive</DialogTitle>
          <DialogDescription>
            Select a Google Drive folder to import images. Only image files will be imported.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {loading ? (
            <div className="flex flex-col items-center justify-center space-y-4 py-12">
              <Loader2 className="h-12 w-12 animate-spin text-blue-600" />
              <div className="text-center space-y-2">
                <h4 className="font-semibold">Scanning folder...</h4>
                <p className="text-sm text-muted-foreground">
                  Finding images in your Google Drive folder and subfolders.
                  <br />
                  This may take a moment for large folders.
                </p>
              </div>
            </div>
          ) : !selectedFolder ? (
            <div className="flex flex-col items-center justify-center space-y-4 py-8">
              <FolderOpen className="h-16 w-16 text-muted-foreground" />
              <Button
                onClick={handleOpenPicker}
                disabled={!accessToken}
                className="w-full"
              >
                <FolderOpen className="mr-2 h-4 w-4" />
                Select Google Drive Folder
              </Button>
              {!accessToken && (
                <p className="text-sm text-muted-foreground">
                  Please connect your Google account to continue
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {/* Folder Info Header */}
              <div className="rounded-lg border p-4 bg-muted/50">
                <div className="flex items-start justify-between">
                  <div className="space-y-1">
                    <h4 className="font-semibold">{selectedFolder.name}</h4>
                    <div className="flex items-center text-sm text-muted-foreground">
                      <Image className="mr-1 h-4 w-4" />
                      {availableFiles.length} image{availableFiles.length !== 1 ? 's' : ''} found • {selectedFileIds.size} selected
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" onClick={handleReset}>
                    Change Folder
                  </Button>
                </div>
              </div>

              {/* Select All/None Controls */}
              <div className="flex items-center justify-between px-1">
                <span className="text-sm font-medium">Select images to import:</span>
                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleSelectAll}
                    disabled={selectedFileIds.size === availableFiles.length}
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

              {/* File List with Checkboxes */}
              <ScrollArea className="h-[300px] rounded-md border">
                <div className="p-4 space-y-2">
                  {availableFiles.map((file) => (
                    <div
                      key={file.id}
                      className="flex items-center space-x-3 p-2 rounded hover:bg-muted/50 cursor-pointer"
                      onClick={() => handleToggleFile(file.id)}
                    >
                      <Checkbox
                        checked={selectedFileIds.has(file.id)}
                        onCheckedChange={() => handleToggleFile(file.id)}
                      />
                      {file.thumbnailLink ? (
                        <img
                          src={file.thumbnailLink}
                          alt={file.name}
                          className="w-10 h-10 object-cover rounded"
                        />
                      ) : (
                        <div className="w-10 h-10 bg-muted rounded flex items-center justify-center">
                          <Image className="w-5 h-5 text-muted-foreground" />
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{file.name}</p>
                        <p className="text-xs text-muted-foreground">{file.mimeType.replace('image/', '')}</p>
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
                  Will import {selectedFileIds.size} of {availableFiles.length} images
                  {selectedFileIds.size > 0 && ` • Est. time: ~${Math.ceil(selectedFileIds.size * 0.5 / 60)} min`}
                </AlertDescription>
              </Alert>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {selectedFolder && (
            <Button onClick={handleConfirm} disabled={selectedFileIds.size === 0}>
              Start Import ({selectedFileIds.size})
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
