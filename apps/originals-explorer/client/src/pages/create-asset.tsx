import { useState } from "react";
import { useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ProgressIndicator } from "@/components/wizard/progress-indicator";
import { SuccessModal } from "@/components/modals/success-modal";
import { ArrowLeft, ArrowRight, Upload, Plus } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Asset } from "@shared/schema";

const steps = [
  { id: 1, name: "Metadata", description: "Basic asset information" },
  { id: 2, name: "Media", description: "Upload asset files" },
  { id: 3, name: "Credentials", description: "Add verification" },
  { id: 4, name: "Confirm", description: "Review and create" },
];

const metadataSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  category: z.string().optional(),
  tags: z.string().optional(),
});

const mediaSchema = z.object({
  mediaUrl: z.string().optional(),
});

const credentialsSchema = z.object({
  credentials: z.record(z.any()).optional(),
});

type MetadataFormData = z.infer<typeof metadataSchema>;
type MediaFormData = z.infer<typeof mediaSchema>;
type CredentialsFormData = z.infer<typeof credentialsSchema>;

export default function CreateAsset() {
  const [, setLocation] = useLocation();
  const [currentStep, setCurrentStep] = useState(1);
  const [formData, setFormData] = useState<Partial<Asset>>({});
  const [createdAsset, setCreatedAsset] = useState<Asset | null>(null);
  const [showSuccessModal, setShowSuccessModal] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Mock user ID for now
  const mockUserId = "user_123";

  const metadataForm = useForm<MetadataFormData>({
    resolver: zodResolver(metadataSchema),
    defaultValues: {
      title: "",
      description: "",
      category: "",
      tags: "",
    },
  });

  const mediaForm = useForm<MediaFormData>({
    resolver: zodResolver(mediaSchema),
    defaultValues: {
      mediaUrl: "",
    },
  });

  const credentialsForm = useForm<CredentialsFormData>({
    resolver: zodResolver(credentialsSchema),
    defaultValues: {
      credentials: {},
    },
  });

  const createAssetMutation = useMutation({
    mutationFn: async (data: any) => {
      return apiRequest("POST", "/api/assets", data);
    },
    onSuccess: async (response) => {
      const asset = await response.json();
      setCreatedAsset(asset);
      setShowSuccessModal(true);
      queryClient.invalidateQueries({ predicate: (query) => 
        query.queryKey[0] === "/api/assets" || query.queryKey[0]?.toString().startsWith("/api/assets?")
      });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({
        title: "Asset Created",
        description: "Your digital asset has been successfully created!",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Creation Failed",
        description: error.message || "Failed to create asset. Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleNextStep = () => {
    if (currentStep < 4) {
      setCurrentStep(currentStep + 1);
    }
  };

  const handlePrevStep = () => {
    if (currentStep > 1) {
      setCurrentStep(currentStep - 1);
    }
  };

  const handleMetadataSubmit = (data: MetadataFormData) => {
    const processedData = {
      ...data,
      tags: data.tags ? data.tags.split(',').map(tag => tag.trim()).filter(Boolean) : [],
    };
    setFormData(prev => ({ ...prev, ...processedData }));
    handleNextStep();
  };

  const handleMediaSubmit = (data: MediaFormData) => {
    setFormData(prev => ({ ...prev, ...data }));
    handleNextStep();
  };

  const handleCredentialsSubmit = (data: CredentialsFormData) => {
    setFormData(prev => ({ ...prev, ...data }));
    handleNextStep();
  };

  const handleFinalSubmit = () => {
    const finalData = {
      ...formData,
      userId: mockUserId,
      assetType: "original",
      status: "completed",
    };
    createAssetMutation.mutate(finalData);
  };

  const handleBackToDashboard = () => {
    setLocation("/");
  };

  const handleCreateAnother = () => {
    setShowSuccessModal(false);
    setCreatedAsset(null);
    setCurrentStep(1);
    setFormData({});
    metadataForm.reset();
    mediaForm.reset();
    credentialsForm.reset();
  };

  const handleViewPortfolio = () => {
    setShowSuccessModal(false);
    setLocation("/");
  };

  return (
    <div className="max-w-3xl mx-auto px-8 py-16">
      {/* Header */}
      <div className="mb-16">
        <button 
          onClick={handleBackToDashboard}
          className="text-gray-500 hover:text-gray-700 text-sm mb-8 flex items-center transition-colors"
          data-testid="back-to-dashboard"
        >
          <ArrowLeft className="mr-2 w-4 h-4" />
          Back
        </button>
        
        {/* Simple progress indicator */}
        <div className="flex items-center space-x-2 mb-8">
          {steps.map((step, index) => (
            <div key={step.id} className="flex items-center">
              <div className={`text-xs px-2 py-1 rounded-sm ${
                step.id <= currentStep 
                  ? 'bg-gray-900 text-white' 
                  : 'bg-gray-100 text-gray-500'
              }`}>
                {step.id}
              </div>
              <span className={`ml-2 text-xs ${
                step.id <= currentStep ? 'text-gray-900' : 'text-gray-500'
              }`}>
                {step.name}
              </span>
              {index < steps.length - 1 && <div className="w-8 h-px bg-gray-200 mx-4" />}
            </div>
          ))}
        </div>
        
        <h1 className="page-title">Create Original Asset</h1>
      </div>

      {/* Step Content */}
      <div className="max-w-2xl mx-auto">
        {currentStep === 1 && (
          <Card>
            <CardHeader className="text-center">
              <CardTitle className="text-3xl font-bold text-neutral-900 mb-4">
                Asset Metadata
              </CardTitle>
              <p className="text-lg text-neutral-600">
                Provide basic information about your digital asset
              </p>
            </CardHeader>
            <CardContent>
              <Form {...metadataForm}>
                <form onSubmit={metadataForm.handleSubmit(handleMetadataSubmit)} className="space-y-8">
                  <FormField
                    control={metadataForm.control}
                    name="title"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Asset Title *</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="Enter a descriptive title for your asset"
                            {...field}
                            data-testid="asset-title-input"
                          />
                        </FormControl>
                        <FormDescription>
                          This will be the primary identifier for your asset
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={metadataForm.control}
                    name="description"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Description</FormLabel>
                        <FormControl>
                          <Textarea
                            placeholder="Describe your asset, its significance, or any relevant details..."
                            rows={4}
                            {...field}
                            data-testid="asset-description-input"
                          />
                        </FormControl>
                        <FormDescription>
                          Optional but recommended for better asset discovery
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                    <FormField
                      control={metadataForm.control}
                      name="category"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Category</FormLabel>
                          <Select onValueChange={field.onChange} value={field.value}>
                            <FormControl>
                              <SelectTrigger data-testid="asset-category-select">
                                <SelectValue placeholder="Select a category" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="art">Digital Art</SelectItem>
                              <SelectItem value="music">Music</SelectItem>
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
                      control={metadataForm.control}
                      name="tags"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Tags</FormLabel>
                          <FormControl>
                            <Input
                              placeholder="art, digital, original"
                              {...field}
                              data-testid="asset-tags-input"
                            />
                          </FormControl>
                          <FormDescription>
                            Separate tags with commas
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                  <div className="flex justify-end pt-8">
                    <Button type="submit" className="btn-primary" data-testid="continue-to-media">
                      Continue to Media
                      <ArrowRight className="ml-2 w-4 h-4" />
                    </Button>
                  </div>
                </form>
              </Form>
            </CardContent>
          </Card>
        )}

        {currentStep === 2 && (
          <Card>
            <CardHeader className="text-center">
              <CardTitle className="text-3xl font-bold text-neutral-900 mb-4">
                Upload Media
              </CardTitle>
              <p className="text-lg text-neutral-600">
                Add files or media to your digital asset
              </p>
            </CardHeader>
            <CardContent>
              <Form {...mediaForm}>
                <form onSubmit={mediaForm.handleSubmit(handleMediaSubmit)} className="space-y-8">
                  <div className="border-2 border-dashed border-neutral-200 rounded-xl p-8 text-center">
                    <Upload className="w-12 h-12 text-neutral-400 mx-auto mb-4" />
                    <p className="text-lg font-medium text-neutral-900 mb-2">
                      Upload your media files
                    </p>
                    <p className="text-neutral-600 mb-6">
                      Drag and drop files here or click to browse
                    </p>
                    <Button variant="outline" data-testid="upload-media-button">
                      Browse Files
                    </Button>
                    <p className="text-sm text-neutral-500 mt-4">
                      Supports images, videos, audio, and documents up to 50MB
                    </p>
                  </div>

                  <FormField
                    control={mediaForm.control}
                    name="mediaUrl"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Or enter media URL</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="https://example.com/your-media-file"
                            {...field}
                            data-testid="media-url-input"
                          />
                        </FormControl>
                        <FormDescription>
                          You can also provide a URL to your media file
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <div className="flex justify-between pt-8">
                    <Button 
                      type="button" 
                      variant="outline" 
                      onClick={handlePrevStep}
                      data-testid="back-to-metadata"
                    >
                      <ArrowLeft className="mr-2 w-4 h-4" />
                      Back
                    </Button>
                    <Button type="submit" className="btn-primary" data-testid="continue-to-credentials">
                      Continue to Credentials
                      <ArrowRight className="ml-2 w-4 h-4" />
                    </Button>
                  </div>
                </form>
              </Form>
            </CardContent>
          </Card>
        )}

        {currentStep === 3 && (
          <Card>
            <CardHeader className="text-center">
              <CardTitle className="text-3xl font-bold text-neutral-900 mb-4">
                Add Credentials
              </CardTitle>
              <p className="text-lg text-neutral-600">
                Attach verifiable credentials to authenticate your asset
              </p>
            </CardHeader>
            <CardContent>
              <div className="space-y-6">
                <div className="bg-neutral-50 rounded-xl p-6">
                  <h4 className="font-semibold text-neutral-900 mb-3">Available Credential Types</h4>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between p-3 bg-white rounded-lg border">
                      <div>
                        <div className="font-medium text-neutral-900">Creator Identity</div>
                        <div className="text-sm text-neutral-600">Verify you are the original creator</div>
                      </div>
                      <Button variant="outline" size="sm" data-testid="add-creator-identity">
                        Add
                      </Button>
                    </div>
                    <div className="flex items-center justify-between p-3 bg-white rounded-lg border">
                      <div>
                        <div className="font-medium text-neutral-900">Ownership Proof</div>
                        <div className="text-sm text-neutral-600">Document legal ownership rights</div>
                      </div>
                      <Button variant="outline" size="sm" data-testid="add-ownership-proof">
                        Add
                      </Button>
                    </div>
                    <div className="flex items-center justify-between p-3 bg-white rounded-lg border">
                      <div>
                        <div className="font-medium text-neutral-900">Authenticity Certificate</div>
                        <div className="text-sm text-neutral-600">Third-party verification of authenticity</div>
                      </div>
                      <Button variant="outline" size="sm" data-testid="add-authenticity-cert">
                        Add
                      </Button>
                    </div>
                  </div>
                </div>

                <div className="text-center py-8 text-neutral-600">
                  <p className="mb-2">No credentials added yet</p>
                  <p className="text-sm">Credentials help verify the authenticity of your asset</p>
                </div>

                <div className="flex justify-between pt-8">
                  <Button 
                    type="button" 
                    variant="outline" 
                    onClick={handlePrevStep}
                    data-testid="back-to-media"
                  >
                    <ArrowLeft className="mr-2 w-4 h-4" />
                    Back
                  </Button>
                  <Button 
                    onClick={() => credentialsForm.handleSubmit(handleCredentialsSubmit)()}
                    className="btn-primary"
                    data-testid="continue-to-confirm"
                  >
                    Continue to Review
                    <ArrowRight className="ml-2 w-4 h-4" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {currentStep === 4 && (
          <Card>
            <CardHeader className="text-center">
              <CardTitle className="text-3xl font-bold text-neutral-900 mb-4">
                Review & Confirm
              </CardTitle>
              <p className="text-lg text-neutral-600">
                Review your asset details before creating
              </p>
            </CardHeader>
            <CardContent>
              <div className="space-y-6">
                <div className="bg-neutral-50 rounded-xl p-6">
                  <h4 className="font-semibold text-neutral-900 mb-4">Asset Summary</h4>
                  <div className="space-y-3">
                    <div>
                      <div className="text-sm text-neutral-600">Title</div>
                      <div className="font-medium text-neutral-900" data-testid="review-title">
                        {formData.title || "Untitled"}
                      </div>
                    </div>
                    {formData.description && (
                      <div>
                        <div className="text-sm text-neutral-600">Description</div>
                        <div className="text-neutral-900" data-testid="review-description">
                          {formData.description}
                        </div>
                      </div>
                    )}
                    {formData.category && (
                      <div>
                        <div className="text-sm text-neutral-600">Category</div>
                        <div className="text-neutral-900" data-testid="review-category">
                          {formData.category}
                        </div>
                      </div>
                    )}
                    {formData.tags && formData.tags.length > 0 && (
                      <div>
                        <div className="text-sm text-neutral-600">Tags</div>
                        <div className="flex flex-wrap gap-2 mt-1">
                          {formData.tags.map((tag, index) => (
                            <span 
                              key={index}
                              className="bg-accent/10 text-accent px-2 py-1 rounded-full text-sm"
                              data-testid={`review-tag-${index}`}
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <div className="bg-amber-50 border border-amber-200 rounded-xl p-6">
                  <h4 className="font-semibold text-amber-900 mb-2">Important Note</h4>
                  <p className="text-amber-800 text-sm">
                    Once created, this asset will be permanently recorded on the blockchain. 
                    Please ensure all information is correct before proceeding.
                  </p>
                </div>

                <div className="flex justify-between pt-8">
                  <Button 
                    type="button" 
                    variant="outline" 
                    onClick={handlePrevStep}
                    data-testid="back-to-credentials"
                  >
                    <ArrowLeft className="mr-2 w-4 h-4" />
                    Back
                  </Button>
                  <Button 
                    onClick={handleFinalSubmit}
                    disabled={createAssetMutation.isPending}
                    className="btn-primary"
                    data-testid="create-asset-final"
                  >
                    {createAssetMutation.isPending ? "Creating..." : "Create Asset"}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      <SuccessModal
        isOpen={showSuccessModal}
        onClose={() => setShowSuccessModal(false)}
        asset={createdAsset}
        onCreateAnother={handleCreateAnother}
        onViewPortfolio={handleViewPortfolio}
      />
    </div>
  );
}
