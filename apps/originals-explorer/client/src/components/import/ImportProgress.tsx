import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import { Progress } from '../ui/progress';
import { Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { Button } from '../ui/button';

interface ImportProgressProps {
  importId: string;
  isOpen: boolean;
  onComplete: () => void;
}

interface ImportStatus {
  status: string;
  progress: number;
  totalFiles: number;
  processedFiles: number;
  failedFiles: number;
  errors?: Array<{ fileId: string; fileName: string; error: string }>;
}

export function ImportProgress({ importId, isOpen, onComplete }: ImportProgressProps) {
  const [status, setStatus] = useState<ImportStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!importId || !isOpen) return;

    const pollStatus = async () => {
      try {
        const response = await fetch(`/api/import/google-drive/status/${importId}`);
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || 'Failed to get status');
        }

        setStatus(data);

        // If import is complete or failed, stop polling
        if (data.status === 'completed' || data.status === 'failed') {
          clearInterval(intervalId);
        }
      } catch (err: any) {
        setError(err.message);
        clearInterval(intervalId);
      }
    };

    // Initial poll
    pollStatus();

    // Poll every 2 seconds
    const intervalId = setInterval(pollStatus, 2000);

    return () => clearInterval(intervalId);
  }, [importId, isOpen]);

  const handleClose = () => {
    if (status?.status === 'completed' || status?.status === 'failed') {
      onComplete();
    }
  };

  if (!status && !error) {
    return (
      <Dialog open={isOpen} onOpenChange={() => {}}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Starting Import...</DialogTitle>
          </DialogHeader>
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  if (error) {
    return (
      <Dialog open={isOpen} onOpenChange={onComplete}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Import Error</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="flex items-center space-x-2 text-destructive">
              <XCircle className="h-5 w-5" />
              <span>{error}</span>
            </div>
            <Button onClick={onComplete} className="w-full">
              Close
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  const isComplete = status?.status === 'completed';
  const isFailed = status?.status === 'failed';
  const successfulFiles = status ? status.processedFiles - status.failedFiles : 0;

  return (
    <Dialog open={isOpen} onOpenChange={isComplete || isFailed ? handleClose : undefined}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>
            {isComplete ? 'Import Complete!' : isFailed ? 'Import Failed' : 'Importing from Google Drive'}
          </DialogTitle>
          <DialogDescription>
            {isComplete
              ? `Successfully imported ${successfulFiles} image${successfulFiles !== 1 ? 's' : ''}`
              : isFailed
              ? 'The import encountered an error'
              : 'Please wait while we import your images...'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Progress Bar */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Progress</span>
              <span className="font-medium">
                {status?.processedFiles || 0} / {status?.totalFiles || 0}
              </span>
            </div>
            <Progress value={status?.progress || 0} className="h-2" />
            <div className="text-center text-sm font-medium">
              {status?.progress || 0}%
            </div>
          </div>

          {/* Status Stats */}
          <div className="grid grid-cols-3 gap-4 rounded-lg border p-4">
            <div className="text-center">
              <div className="text-2xl font-bold text-green-600">{successfulFiles}</div>
              <div className="text-xs text-muted-foreground">Successful</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-muted-foreground">
                {status?.processedFiles || 0}
              </div>
              <div className="text-xs text-muted-foreground">Processed</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-red-600">{status?.failedFiles || 0}</div>
              <div className="text-xs text-muted-foreground">Failed</div>
            </div>
          </div>

          {/* Status Icon */}
          {isComplete && (
            <div className="flex items-center justify-center space-x-2 text-green-600">
              <CheckCircle2 className="h-6 w-6" />
              <span className="font-medium">All files processed</span>
            </div>
          )}

          {isFailed && (
            <div className="flex items-center justify-center space-x-2 text-destructive">
              <XCircle className="h-6 w-6" />
              <span className="font-medium">Import failed</span>
            </div>
          )}

          {status?.status === 'processing' && (
            <div className="flex items-center justify-center space-x-2 text-primary">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span className="text-sm text-muted-foreground">Processing files...</span>
            </div>
          )}

          {/* Error List */}
          {status?.errors && status.errors.length > 0 && (
            <details className="rounded-lg border p-3">
              <summary className="cursor-pointer text-sm font-medium">
                View Errors ({status.errors.length})
              </summary>
              <div className="mt-2 space-y-2 max-h-40 overflow-y-auto">
                {status.errors.map((error, idx) => (
                  <div key={idx} className="text-xs text-muted-foreground border-l-2 border-red-500 pl-2">
                    <div className="font-medium">{error.fileName}</div>
                    <div className="text-red-600">{error.error}</div>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>

        {(isComplete || isFailed) && (
          <div className="flex justify-end space-x-2">
            <Button onClick={handleClose}>
              {isComplete ? 'View Imported Assets' : 'Close'}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

