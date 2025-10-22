import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import { Progress } from '../ui/progress';
import { Button } from '../ui/button';
import { Alert, AlertDescription } from '../ui/alert';
import { CheckCircle2, XCircle, Loader2, AlertCircle } from 'lucide-react';

interface ImportProgressProps {
  importId: string;
  isOpen: boolean;
  onComplete: () => void;
}

interface ImportStatus {
  importId: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  progress: number;
  totalFiles: number;
  processedFiles: number;
  successfulFiles: number;
  failedFiles: number;
  folderName: string;
  errors?: Array<{ file: string; error: string }>;
}

export function ImportProgress({ importId, isOpen, onComplete }: ImportProgressProps) {
  const [status, setStatus] = useState<ImportStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!importId || !isOpen) return;

    let intervalId: NodeJS.Timeout;

    const fetchStatus = async () => {
      try {
        const response = await fetch(`/api/import/google-drive/status/${importId}`);
        
        if (!response.ok) {
          throw new Error('Failed to fetch import status');
        }

        const data = await response.json();
        setStatus(data);

        // If import is complete or failed, stop polling
        if (data.status === 'completed' || data.status === 'failed') {
          clearInterval(intervalId);
          
          // Wait a moment before calling onComplete to show final status
          if (data.status === 'completed') {
            setTimeout(onComplete, 2000);
          }
        }
      } catch (err: any) {
        console.error('Error fetching import status:', err);
        setError(err.message);
        clearInterval(intervalId);
      }
    };

    // Fetch immediately
    fetchStatus();

    // Then poll every 2 seconds
    intervalId = setInterval(fetchStatus, 2000);

    return () => {
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [importId, isOpen, onComplete]);

  if (!status) {
    return (
      <Dialog open={isOpen}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Loading Import Status</DialogTitle>
          </DialogHeader>
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  const isComplete = status.status === 'completed';
  const isFailed = status.status === 'failed';
  const isProcessing = status.status === 'in_progress' || status.status === 'pending';

  return (
    <Dialog open={isOpen}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>
            {isComplete && 'Import Complete'}
            {isFailed && 'Import Failed'}
            {isProcessing && 'Importing Images'}
          </DialogTitle>
          <DialogDescription>
            {status.folderName}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Progress Bar */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Progress</span>
              <span className="font-medium">{status.progress}%</span>
            </div>
            <Progress value={status.progress} className="h-2" />
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{status.processedFiles} of {status.totalFiles} files processed</span>
            </div>
          </div>

          {/* Status Summary */}
          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-lg border p-4 bg-muted/50">
              <div className="flex items-center gap-2 text-green-600 mb-1">
                <CheckCircle2 className="h-4 w-4" />
                <span className="text-sm font-medium">Successful</span>
              </div>
              <div className="text-2xl font-bold">{status.successfulFiles}</div>
            </div>

            {status.failedFiles > 0 && (
              <div className="rounded-lg border p-4 bg-muted/50">
                <div className="flex items-center gap-2 text-red-600 mb-1">
                  <XCircle className="h-4 w-4" />
                  <span className="text-sm font-medium">Failed</span>
                </div>
                <div className="text-2xl font-bold">{status.failedFiles}</div>
              </div>
            )}
          </div>

          {/* Status Messages */}
          {isProcessing && (
            <Alert>
              <Loader2 className="h-4 w-4 animate-spin" />
              <AlertDescription>
                Creating DIDs and importing assets... Please keep this window open.
              </AlertDescription>
            </Alert>
          )}

          {isComplete && (
            <Alert className="border-green-200 bg-green-50">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              <AlertDescription className="text-green-900">
                Successfully imported {status.successfulFiles} image{status.successfulFiles !== 1 ? 's' : ''} to your collection.
              </AlertDescription>
            </Alert>
          )}

          {isFailed && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                Import failed. Please try again or contact support.
              </AlertDescription>
            </Alert>
          )}

          {/* Error Details */}
          {status.errors && status.errors.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium text-muted-foreground">
                  Issues encountered ({status.errors.length}):
                </div>
                {status.errors.length > 5 && (
                  <div className="text-xs text-muted-foreground">
                    Showing first 5
                  </div>
                )}
              </div>
              <div className="max-h-40 overflow-y-auto space-y-1.5 rounded-md border p-3 bg-muted/20">
                {status.errors.slice(0, 5).map((err, idx) => {
                  const isPermissionError = err.error.toLowerCase().includes('permission');
                  const isNetworkError = err.error.toLowerCase().includes('network') ||
                                        err.error.toLowerCase().includes('timeout');
                  const isNotFoundError = err.error.toLowerCase().includes('not found');

                  return (
                    <div key={idx} className="text-xs rounded p-2 bg-background border">
                      <div className="font-medium truncate text-foreground mb-0.5">
                        {err.file}
                      </div>
                      <div className={`
                        ${isPermissionError ? 'text-orange-600' : ''}
                        ${isNetworkError ? 'text-blue-600' : ''}
                        ${isNotFoundError ? 'text-yellow-600' : ''}
                        ${!isPermissionError && !isNetworkError && !isNotFoundError ? 'text-red-600' : ''}
                      `}>
                        {isPermissionError && '🔒 '}
                        {isNetworkError && '🌐 '}
                        {isNotFoundError && '❓ '}
                        {err.error}
                      </div>
                    </div>
                  );
                })}
                {status.errors.length > 5 && (
                  <div className="text-xs text-center text-muted-foreground italic pt-1">
                    + {status.errors.length - 5} more errors
                  </div>
                )}
              </div>

              {/* Error category hints */}
              {status.errors.some(e => e.error.toLowerCase().includes('permission')) && (
                <Alert className="border-orange-200 bg-orange-50">
                  <AlertCircle className="h-4 w-4 text-orange-600" />
                  <AlertDescription className="text-orange-900 text-xs">
                    <strong>Tip:</strong> Permission errors occur when files are not shared with you or have restricted access.
                    Check file sharing settings in Google Drive.
                  </AlertDescription>
                </Alert>
              )}

              {status.errors.some(e => e.error.toLowerCase().includes('network') || e.error.toLowerCase().includes('timeout')) && (
                <Alert className="border-blue-200 bg-blue-50">
                  <AlertCircle className="h-4 w-4 text-blue-600" />
                  <AlertDescription className="text-blue-900 text-xs">
                    <strong>Tip:</strong> Network errors are usually temporary. Try importing these files again.
                  </AlertDescription>
                </Alert>
              )}
            </div>
          )}

          {/* Error Message */}
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>

        {/* Footer Actions */}
        {(isComplete || isFailed) && (
          <div className="flex justify-end">
            <Button onClick={onComplete}>
              Close
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

