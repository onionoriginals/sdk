import { useState, useEffect, useMemo } from "react";
import { useLocation, Link } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { ArrowLeft, Upload, Check, AlertCircle, Loader2 } from "lucide-react";
import { LayerBadge } from "@/components/LayerBadge";
import { apiRequest } from "@/lib/queryClient";
import type { InsertAsset } from "../../../shared/schema";

type PropertyType = "text" | "number" | "boolean" | "date" | "select";

type AssetProperty = {
  id: string;
  key: string;
  label: string;
  type: PropertyType;
  required?: boolean;
  options?: string[];
};

type AssetTypeConfig = {
  id: string;
  name: string;
  description?: string;
  properties: AssetProperty[];
};

const STORAGE_KEY = "originals-asset-types";

function readConfigs(): AssetTypeConfig[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

const createAssetSchema = z.object({
  assetTypeId: z.string().min(1, "Asset type is required"),
  title: z.string().min(1, "Title is required").max(100, "Title too long"),
  description: z.string().max(1000, "Description too long").optional(),
  category: z.string().min(1, "Category is required"),
  tags: z.string().optional(),
  mediaFile: z.instanceof(File).optional(),
  mediaUrl: z.string().url("Invalid URL").optional().or(z.literal("")),
  customProperties: z.record(z.any()).optional(),
});

export default function CreateAssetSimple() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { user, isAuthenticated } = useAuth();
  const [isCreating, setIsCreating] = useState(false);
  const [assetTypes, setAssetTypes] = useState<AssetTypeConfig[]>(() => readConfigs());
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [successResult, setSuccessResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<any>(null);

  const form = useForm<z.infer<typeof createAssetSchema>>({
    resolver: zodResolver(createAssetSchema),
    defaultValues: {
      assetTypeId: "",
      title: "",
      description: "",
      category: "",
      tags: "",
      customProperties: {},
    },
  });

  const selectedAssetTypeId = form.watch("assetTypeId");
  const selectedAssetType = useMemo(
    () => assetTypes.find((t) => t.id === selectedAssetTypeId),
    [assetTypes, selectedAssetTypeId]
  );

  useEffect(() => {
    const handle = () => setAssetTypes(readConfigs());
    window.addEventListener("storage", handle);
    window.addEventListener("originals-asset-types-updated", handle as EventListener);
    return () => {
      window.removeEventListener("storage", handle);
      window.removeEventListener("originals-asset-types-updated", handle as EventListener);
    };
  }, []);

  const createAssetMutation = useMutation({
    mutationFn: async (formData: FormData) => {
      const response = await apiRequest('POST', '/api/assets/create-with-did', formData);
      const result = await response.json();
      console.log("SDK Output:", result);
      return result;
    },
    onSuccess: (data) => {
      console.log("Asset created successfully:", data);
      queryClient.invalidateQueries({ queryKey: ["/api/assets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      setSuccessResult(data);
      setError(null);
      setErrorDetails(null);
      setIsCreating(false);
      toast({
        title: "Success",
        description: "Asset created successfully with DID identifier",
      });
    },
    onError: (e: any) => {
      console.error("Asset creation error:", e);
      setError(e.message || "Failed to create asset. Please try again.");
      setErrorDetails(e);
      setIsCreating(false);
      toast({
        title: "Error",
        description: e.message || "Failed to create asset. Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleSubmit = (values: z.infer<typeof createAssetSchema>) => {
    if (!user?.id) {
      toast({
        title: "Authentication Required",
        description: "Please sign in to create assets.",
        variant: "destructive",
      });
      return;
    }

    // Validate that we have either a file or URL
    if (!selectedFile && !values.mediaUrl) {
      setError("Please upload a file or provide a media URL");
      toast({
        title: "Validation Error",
        description: "Please upload a file or provide a media URL",
        variant: "destructive",
      });
      return;
    }

    setIsCreating(true);
    setError(null);
    setErrorDetails(null);
    
    // Create FormData for file upload
    const formData = new FormData();
    formData.append('title', values.title);
    formData.append('description', values.description || '');
    formData.append('category', values.category);
    
    const tags = values.tags ? values.tags.split(",").map(tag => tag.trim()) : [];
    formData.append('tags', JSON.stringify(tags));
    
    if (selectedFile) {
      formData.append('mediaFile', selectedFile);
    } else if (values.mediaUrl) {
      formData.append('mediaUrl', values.mediaUrl);
    }
    
    const metadata = {
      assetTypeId: values.assetTypeId,
      assetTypeName: selectedAssetType?.name || "",
      customProperties: values.customProperties || {},
    };
    formData.append('metadata', JSON.stringify(metadata));

    createAssetMutation.mutate(formData);
  };

  // File input handler
  const handleFileChange = (file: File | undefined) => {
    if (file) {
      setSelectedFile(file);
      // Create preview
      const reader = new FileReader();
      reader.onloadend = () => {
        setPreviewUrl(reader.result as string);
      };
      reader.readAsDataURL(file);
      // Clear URL if file is selected
      form.setValue('mediaUrl', '');
    } else {
      setSelectedFile(null);
      setPreviewUrl(null);
    }
  };

  if (!isAuthenticated) {
    return (
      <main className="max-w-2xl mx-auto px-8 py-16">
        <div className="bg-white border border-gray-200 rounded-sm p-8 text-center">
          <h1 className="text-2xl font-light mb-4">Authentication Required</h1>
          <p className="text-gray-500 mb-6">Please sign in to create assets.</p>
          <Button onClick={() => setLocation("/login?returnTo=/create")}>
            Sign In
          </Button>
        </div>
      </main>
    );
  }

  return (
    <main className="max-w-2xl mx-auto px-8 py-16">
      <button 
        onClick={() => setLocation("/")}
        className="text-gray-500 hover:text-gray-700 text-sm mb-12 flex items-center transition-colors"
        data-testid="back-to-dashboard"
      >
        <ArrowLeft className="mr-2 w-4 h-4" />
        Back
      </button>

      <h1 className="page-title">Create Original</h1>
      
      <div className="bg-white border border-gray-200 rounded-sm p-8">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-6">
            <FormField
              control={form.control}
              name="assetTypeId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-sm font-medium text-gray-700">Asset Type</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger 
                        className="border-gray-200 focus:border-gray-400 rounded-sm"
                        data-testid="asset-type-select"
                      >
                        <SelectValue placeholder="Select an asset type" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {assetTypes.length === 0 && (
                        <div className="px-2 py-1.5 text-sm text-gray-500">
                          No asset types configured. <a href="/setup" className="underline">Go to Setup</a>
                        </div>
                      )}
                      {assetTypes.map((type) => (
                        <SelectItem key={type.id} value={type.id}>
                          {type.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-sm font-medium text-gray-700">Title</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="Asset title"
                      {...field}
                      className="border-gray-200 focus:border-gray-400 rounded-sm"
                      data-testid="asset-title-input"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-sm font-medium text-gray-700">Description</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Brief description"
                      className="min-h-[80px] border-gray-200 focus:border-gray-400 rounded-sm"
                      {...field}
                      data-testid="asset-description-input"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="category"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-sm font-medium text-gray-700">Category</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger 
                          className="border-gray-200 focus:border-gray-400 rounded-sm"
                          data-testid="category-select"
                        >
                          <SelectValue placeholder="Select" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="art">Art</SelectItem>
                        <SelectItem value="music">Music</SelectItem>
                        <SelectItem value="video">Video</SelectItem>
                        <SelectItem value="document">Document</SelectItem>
                        <SelectItem value="collectible">Collectible</SelectItem>
                        <SelectItem value="other">Other</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="tags"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-sm font-medium text-gray-700">Tags</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="tag1, tag2"
                        {...field}
                        className="border-gray-200 focus:border-gray-400 rounded-sm"
                        data-testid="tags-input"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* Custom Properties */}
            {selectedAssetType && selectedAssetType.properties.length > 0 && (
              <div className="space-y-4 pt-2">
                <div className="text-sm font-medium text-gray-700 border-b pb-2">
                  {selectedAssetType.name} Properties
                </div>
                {selectedAssetType.properties.map((prop) => (
                  <div key={prop.id}>
                    {prop.type === "text" && (
                      <FormItem>
                        <FormLabel className="text-sm font-medium text-gray-700">
                          {prop.label}
                          {prop.required && <span className="text-red-500 ml-1">*</span>}
                        </FormLabel>
                        <FormControl>
                          <Input
                            placeholder={prop.label}
                            className="border-gray-200 focus:border-gray-400 rounded-sm"
                            value={form.watch(`customProperties.${prop.key}`) || ""}
                            onChange={(e) =>
                              form.setValue(`customProperties.${prop.key}`, e.target.value)
                            }
                          />
                        </FormControl>
                      </FormItem>
                    )}

                    {prop.type === "number" && (
                      <FormItem>
                        <FormLabel className="text-sm font-medium text-gray-700">
                          {prop.label}
                          {prop.required && <span className="text-red-500 ml-1">*</span>}
                        </FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            placeholder={prop.label}
                            className="border-gray-200 focus:border-gray-400 rounded-sm"
                            value={form.watch(`customProperties.${prop.key}`) || ""}
                            onChange={(e) =>
                              form.setValue(
                                `customProperties.${prop.key}`,
                                e.target.value ? parseFloat(e.target.value) : ""
                              )
                            }
                          />
                        </FormControl>
                      </FormItem>
                    )}

                    {prop.type === "boolean" && (
                      <FormItem className="flex flex-row items-center space-x-3 space-y-0">
                        <FormControl>
                          <Checkbox
                            checked={form.watch(`customProperties.${prop.key}`) || false}
                            onCheckedChange={(checked) =>
                              form.setValue(`customProperties.${prop.key}`, checked)
                            }
                          />
                        </FormControl>
                        <FormLabel className="text-sm font-medium text-gray-700">
                          {prop.label}
                        </FormLabel>
                      </FormItem>
                    )}

                    {prop.type === "date" && (
                      <FormItem>
                        <FormLabel className="text-sm font-medium text-gray-700">
                          {prop.label}
                          {prop.required && <span className="text-red-500 ml-1">*</span>}
                        </FormLabel>
                        <FormControl>
                          <Input
                            type="date"
                            className="border-gray-200 focus:border-gray-400 rounded-sm"
                            value={form.watch(`customProperties.${prop.key}`) || ""}
                            onChange={(e) =>
                              form.setValue(`customProperties.${prop.key}`, e.target.value)
                            }
                          />
                        </FormControl>
                      </FormItem>
                    )}

                    {prop.type === "select" && (
                      <FormItem>
                        <FormLabel className="text-sm font-medium text-gray-700">
                          {prop.label}
                          {prop.required && <span className="text-red-500 ml-1">*</span>}
                        </FormLabel>
                        <Select
                          value={form.watch(`customProperties.${prop.key}`) || ""}
                          onValueChange={(value) =>
                            form.setValue(`customProperties.${prop.key}`, value)
                          }
                        >
                          <FormControl>
                            <SelectTrigger className="border-gray-200 focus:border-gray-400 rounded-sm">
                              <SelectValue placeholder={`Select ${prop.label}`} />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {(prop.options || []).map((option) => (
                              <SelectItem key={option} value={option}>
                                {option}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </FormItem>
                    )}
                  </div>
                ))}
              </div>
            )}

            <FormField
              control={form.control}
              name="mediaFile"
              render={({ field: { value, onChange, ...field } }) => (
                <FormItem>
                  <FormLabel className="text-sm font-medium text-gray-700">Media File</FormLabel>
                  <FormControl>
                    <div className="space-y-4">
                      {/* File input */}
                      <div className="border-2 border-dashed border-gray-200 rounded-sm p-6 text-center hover:border-gray-300 transition-colors">
                        <input
                          {...field}
                          type="file"
                          accept="image/*,video/*,audio/*"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            onChange(file);
                            handleFileChange(file);
                          }}
                          className="hidden"
                          id="media-upload"
                          data-testid="media-upload-input"
                        />
                        <label
                          htmlFor="media-upload"
                          className="cursor-pointer flex flex-col items-center space-y-2"
                        >
                          <Upload className="w-6 h-6 text-gray-400" />
                          <span className="text-sm text-gray-500">
                            {selectedFile ? selectedFile.name : "Click to upload file"}
                          </span>
                        </label>
                      </div>
                      
                      {/* Preview */}
                      {previewUrl && (
                        <div className="relative w-full h-48 border border-gray-200 rounded-sm overflow-hidden">
                          <img 
                            src={previewUrl} 
                            alt="Preview" 
                            className="w-full h-full object-contain"
                          />
                        </div>
                      )}
                      
                      {/* OR divider */}
                      <div className="relative">
                        <div className="absolute inset-0 flex items-center">
                          <div className="w-full border-t border-gray-200"></div>
                        </div>
                        <div className="relative flex justify-center text-xs uppercase">
                          <span className="bg-white px-2 text-gray-500">Or</span>
                        </div>
                      </div>
                    </div>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="mediaUrl"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-sm font-medium text-gray-700">Media URL</FormLabel>
                  <FormControl>
                    <Input
                      type="url"
                      placeholder="https://example.com/image.jpg"
                      {...field}
                      className="border-gray-200 focus:border-gray-400 rounded-sm"
                      data-testid="media-url-input"
                      onChange={(e) => {
                        field.onChange(e);
                        if (e.target.value) {
                          setSelectedFile(null);
                          setPreviewUrl(null);
                        }
                      }}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Error Display */}
            {error && (
              <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-sm">
                <div className="flex items-center gap-2 mb-2">
                  <AlertCircle className="w-4 h-4 text-red-600" />
                  <h4 className="font-medium text-red-900">Creation Failed</h4>
                </div>
                <p className="text-sm text-red-700">{error}</p>
                {errorDetails && (
                  <details className="mt-2">
                    <summary className="text-xs text-red-600 cursor-pointer">Technical details</summary>
                    <pre className="mt-2 text-xs text-red-800 bg-white p-2 rounded-sm overflow-x-auto">
                      {JSON.stringify(errorDetails, null, 2)}
                    </pre>
                  </details>
                )}
              </div>
            )}

            <div className="pt-6 border-t border-gray-200">
              {/* Loading State */}
              {isCreating && (
                <div className="flex items-center justify-center gap-2 text-sm text-gray-600 mb-4">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Creating asset with DID identifier...</span>
                </div>
              )}
              
              <button 
                type="submit" 
                disabled={isCreating || createAssetMutation.isPending}
                className="minimal-button w-full"
                data-testid="create-asset-button"
              >
                {isCreating || createAssetMutation.isPending ? "Creating..." : "Create Asset"}
              </button>
            </div>
          </form>
        </Form>

        {/* Success State Display */}
        {successResult && (
          <div className="mt-6 p-6 bg-green-50 border border-green-200 rounded-sm">
            <div className="flex items-center gap-2 mb-4">
              <Check className="w-5 h-5 text-green-600" />
              <h3 className="font-medium text-green-900">Asset Created Successfully!</h3>
            </div>
            
            {/* Layer Badge */}
            <div className="mb-4">
              <LayerBadge layer="did:peer" size="md" />
            </div>
            
            {/* DID Information */}
            <div className="space-y-3">
              <div>
                <div className="text-xs text-green-700 mb-1">DID Identifier</div>
                <div className="font-mono text-sm text-green-900 break-all bg-white p-2 rounded-sm border border-green-200">
                  {successResult.asset.didPeer}
                </div>
              </div>
              
              {/* Credentials */}
              {successResult.asset.credentials && (
                <div>
                  <div className="text-xs text-green-700 mb-1">Verifiable Credentials</div>
                  <div className="text-xs font-mono text-green-800 bg-white p-2 rounded-sm border border-green-200 max-h-32 overflow-y-auto">
                    {JSON.stringify(successResult.asset.credentials, null, 2)}
                  </div>
                </div>
              )}
              
              {/* Provenance */}
              {successResult.asset.provenance && (
                <div>
                  <div className="text-xs text-green-700 mb-1">Provenance</div>
                  <div className="text-xs text-green-800 bg-white p-2 rounded-sm border border-green-200">
                    {successResult.asset.provenance.events?.length || 0} event(s) recorded
                  </div>
                </div>
              )}
            </div>
            
            {/* Actions */}
            <div className="flex gap-3 mt-4">
              <Link href="/dashboard">
                <Button size="sm" variant="outline">View Dashboard</Button>
              </Link>
              <Link href={`/assets/${successResult.asset.id}`}>
                <Button size="sm">View Asset</Button>
              </Link>
              <Button 
                size="sm" 
                variant="outline"
                onClick={() => {
                  setSuccessResult(null);
                  setSelectedFile(null);
                  setPreviewUrl(null);
                  form.reset();
                }}
              >
                Create Another
              </Button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}