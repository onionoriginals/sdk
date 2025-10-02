import { useState, useRef } from "react";
import { useLocation } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Upload, FileSpreadsheet, CheckCircle, XCircle, AlertCircle } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type UploadResult = {
  success: boolean;
  created: number;
  failed: number;
  assets: any[];
  errors?: Array<{ row: number; error: string }>;
};

type PreviewRow = {
  [key: string]: any;
};

export default function UploadAssets() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { user, isAuthenticated } = useAuth();
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewData, setPreviewData] = useState<PreviewRow[]>([]);
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append('file', file);
      
      const response = await apiRequest("POST", "/api/assets/upload-spreadsheet", formData);
      const result = await response.json();
      return result;
    },
    onSuccess: (data: UploadResult) => {
      setUploadResult(data);
      queryClient.invalidateQueries({ queryKey: ["/api/assets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/asset-types"] });
      
      if (data.failed === 0) {
        toast({
          title: "Success!",
          description: `Successfully created ${data.created} assets`,
        });
      } else {
        toast({
          title: "Partial Success",
          description: `Created ${data.created} assets, ${data.failed} failed`,
          variant: "destructive",
        });
      }
    },
    onError: (error: any) => {
      toast({
        title: "Upload Failed",
        description: error.message || "Failed to upload spreadsheet",
        variant: "destructive",
      });
    },
  });

  const handleFileSelect = (file: File) => {
    setSelectedFile(file);
    setPreviewData([]);
    setUploadResult(null);
    
    // Read first few rows for preview
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        if (file.name.endsWith('.csv')) {
          const text = e.target?.result as string;
          const lines = text.split('\n').filter(line => line.trim());
          if (lines.length > 0) {
            const headers = lines[0].split(',').map(h => h.trim());
            const preview = lines.slice(1, 6).map(line => {
              const values = line.split(',').map(v => v.trim());
              const row: PreviewRow = {};
              headers.forEach((header, i) => {
                row[header] = values[i] || '';
              });
              return row;
            });
            setPreviewData(preview);
          }
        } else if (file.name.match(/\.(xlsx|xls)$/)) {
          // For XLSX files, we'll import the library dynamically to reduce bundle size
          try {
            const XLSX = await import('xlsx');
            const arrayBuffer = e.target?.result as ArrayBuffer;
            const workbook = XLSX.read(arrayBuffer, { type: 'array' });
            const sheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[sheetName];
            const jsonData = XLSX.utils.sheet_to_json(worksheet) as PreviewRow[];
            setPreviewData(jsonData.slice(0, 5));
          } catch (error) {
            console.error("Error parsing XLSX file:", error);
            toast({
              title: "Preview Error",
              description: "Could not preview XLSX file, but you can still upload it",
              variant: "destructive",
            });
            // Set a minimal preview to enable upload button
            setPreviewData([{ note: "Preview not available for XLSX files" }]);
          }
        }
      } catch (error) {
        console.error("Error previewing file:", error);
      }
    };
    
    // Read as text for CSV, as ArrayBuffer for XLSX
    if (file.name.endsWith('.csv')) {
      reader.readAsText(file);
    } else {
      reader.readAsArrayBuffer(file);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    
    const files = Array.from(e.dataTransfer.files);
    const file = files.find(f => 
      f.name.endsWith('.csv') || 
      f.name.endsWith('.xlsx') || 
      f.name.endsWith('.xls')
    );
    
    if (file) {
      handleFileSelect(file);
    } else {
      toast({
        title: "Invalid File",
        description: "Please upload a CSV or XLSX file",
        variant: "destructive",
      });
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleFileSelect(file);
    }
  };

  const handleUpload = () => {
    if (selectedFile) {
      uploadMutation.mutate(selectedFile);
    }
  };

  if (!isAuthenticated) {
    return (
      <main className="max-w-4xl mx-auto px-8 py-16">
        <div className="bg-white border border-gray-200 rounded-sm p-8 text-center">
          <h1 className="text-2xl font-light mb-4">Authentication Required</h1>
          <p className="text-gray-500 mb-6">Please sign in to upload assets.</p>
          <Button onClick={() => setLocation("/login?returnTo=/upload-assets")}>
            Sign In
          </Button>
        </div>
      </main>
    );
  }

  return (
    <main className="max-w-6xl mx-auto px-8 py-16">
      <button 
        onClick={() => setLocation("/dashboard")}
        className="text-gray-500 hover:text-gray-700 text-sm mb-12 flex items-center transition-colors"
      >
        <ArrowLeft className="mr-2 w-4 h-4" />
        Back to Dashboard
      </button>

      <h1 className="page-title mb-2">Upload Assets from Spreadsheet</h1>
      <p className="text-gray-500 mb-8">
        Upload a CSV or XLSX file to create multiple assets at once
      </p>

      {/* File Upload Area */}
      <Card className="mb-8">
        <CardHeader>
          <CardTitle>Select File</CardTitle>
          <CardDescription>
            Upload a CSV or XLSX file containing your asset data
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            className={`border-2 border-dashed rounded-lg p-12 text-center transition-colors ${
              isDragging 
                ? 'border-gray-400 bg-gray-50' 
                : 'border-gray-200 hover:border-gray-300'
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.xlsx,.xls"
              onChange={handleFileInput}
              className="hidden"
            />
            
            {selectedFile ? (
              <div className="space-y-4">
                <FileSpreadsheet className="w-12 h-12 text-green-500 mx-auto" />
                <div>
                  <p className="text-lg font-medium text-gray-900">{selectedFile.name}</p>
                  <p className="text-sm text-gray-500">
                    {(selectedFile.size / 1024).toFixed(2)} KB
                  </p>
                </div>
                <Button
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                >
                  Choose Different File
                </Button>
              </div>
            ) : (
              <div className="space-y-4">
                <Upload className="w-12 h-12 text-gray-400 mx-auto" />
                <div>
                  <p className="text-lg text-gray-700 mb-2">
                    Drag and drop your file here, or
                  </p>
                  <Button onClick={() => fileInputRef.current?.click()}>
                    Browse Files
                  </Button>
                </div>
                <p className="text-sm text-gray-500">
                  Supports CSV and XLSX files (max 10MB)
                </p>
              </div>
            )}
          </div>

          {/* Required Format Info */}
          <Alert className="mt-6">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              <strong>Required columns:</strong> title, assetType, category
              <br />
              <strong>Optional columns:</strong> description, tags, mediaUrl, status, and any custom properties
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      {/* Preview Table */}
      {previewData.length > 0 && !uploadResult && (
        <Card className="mb-8">
          <CardHeader>
            <CardTitle>Preview (First 5 Rows)</CardTitle>
            <CardDescription>
              Review your data before uploading
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    {Object.keys(previewData[0]).map((header) => (
                      <TableHead key={header}>{header}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {previewData.map((row, idx) => (
                    <TableRow key={idx}>
                      {Object.values(row).map((value, cellIdx) => (
                        <TableCell key={cellIdx} className="max-w-xs truncate">
                          {String(value)}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            
            <div className="flex justify-end gap-4 mt-6">
              <Button
                variant="outline"
                onClick={() => {
                  setSelectedFile(null);
                  setPreviewData([]);
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={handleUpload}
                disabled={uploadMutation.isPending}
              >
                {uploadMutation.isPending ? "Uploading..." : "Upload Assets"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Upload Progress */}
      {uploadMutation.isPending && (
        <Card className="mb-8">
          <CardContent className="pt-6">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Processing spreadsheet...</span>
              </div>
              <Progress value={undefined} className="w-full" />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Upload Results */}
      {uploadResult && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {uploadResult.failed === 0 ? (
                <>
                  <CheckCircle className="w-5 h-5 text-green-500" />
                  Upload Successful
                </>
              ) : (
                <>
                  <AlertCircle className="w-5 h-5 text-yellow-500" />
                  Upload Completed with Errors
                </>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                  <div className="flex items-center gap-2 text-green-700">
                    <CheckCircle className="w-5 h-5" />
                    <span className="font-medium">Created</span>
                  </div>
                  <p className="text-3xl font-bold text-green-900 mt-2">
                    {uploadResult.created}
                  </p>
                </div>
                
                {uploadResult.failed > 0 && (
                  <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                    <div className="flex items-center gap-2 text-red-700">
                      <XCircle className="w-5 h-5" />
                      <span className="font-medium">Failed</span>
                    </div>
                    <p className="text-3xl font-bold text-red-900 mt-2">
                      {uploadResult.failed}
                    </p>
                  </div>
                )}
              </div>

              {uploadResult.errors && uploadResult.errors.length > 0 && (
                <div className="mt-6">
                  <h3 className="font-medium text-gray-900 mb-3">Error Details</h3>
                  <div className="bg-red-50 border border-red-200 rounded-lg p-4 max-h-64 overflow-y-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Row</TableHead>
                          <TableHead>Error</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {uploadResult.errors.map((error, idx) => (
                          <TableRow key={idx}>
                            <TableCell>{error.row}</TableCell>
                            <TableCell className="text-red-700">{error.error}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              )}

              <div className="flex justify-end gap-4 mt-6 pt-6 border-t">
                <Button
                  variant="outline"
                  onClick={() => {
                    setSelectedFile(null);
                    setPreviewData([]);
                    setUploadResult(null);
                  }}
                >
                  Upload Another File
                </Button>
                <Button onClick={() => setLocation("/assets")}>
                  View Assets
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </main>
  );
}
