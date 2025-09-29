import { useState } from "react";
import { useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ProgressIndicator } from "@/components/wizard/progress-indicator";
import { SuccessModal } from "@/components/modals/success-modal";
import { ArrowLeft, ArrowRight, Search, AlertTriangle } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Asset } from "@shared/schema";

const steps = [
  { id: 1, name: "Import", description: "Find existing asset" },
  { id: 2, name: "Verify", description: "Confirm ownership" },
  { id: 3, name: "Credentials", description: "Add verification" },
  { id: 4, name: "Complete", description: "Finalize migration" },
];

const importSchema = z.object({
  originalReference: z.string().min(1, "Asset reference is required"),
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
});

const verifySchema = z.object({
  ownershipProof: z.string().min(1, "Ownership proof is required"),
});

const credentialsSchema = z.object({
  credentials: z.record(z.any()).optional(),
});

type ImportFormData = z.infer<typeof importSchema>;
type VerifyFormData = z.infer<typeof verifySchema>;
type CredentialsFormData = z.infer<typeof credentialsSchema>;

export default function MigrateAsset() {
  const [, setLocation] = useLocation();
  const [currentStep, setCurrentStep] = useState(1);
  const [formData, setFormData] = useState<Partial<Asset>>({});
  const [createdAsset, setCreatedAsset] = useState<Asset | null>(null);
  const [showSuccessModal, setShowSuccessModal] = useState(false);
  const [assetFound, setAssetFound] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Mock user ID for now
  const mockUserId = "user_123";

  const importForm = useForm<ImportFormData>({
    resolver: zodResolver(importSchema),
    defaultValues: {
      originalReference: "",
      title: "",
      description: "",
    },
  });

  const verifyForm = useForm<VerifyFormData>({
    resolver: zodResolver(verifySchema),
    defaultValues: {
      ownershipProof: "",
    },
  });

  const credentialsForm = useForm<CredentialsFormData>({
    resolver: zodResolver(credentialsSchema),
    defaultValues: {
      credentials: {},
    },
  });

  const migrateAssetMutation = useMutation({
    mutationFn: async (data: any) => {
      return apiRequest("POST", "/api/assets", data);
    },
    onSuccess: async (response) => {
      const asset = await response.json();
      setCreatedAsset(asset);
      setShowSuccessModal(true);
      queryClient.invalidateQueries({ queryKey: ["/api/assets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({
        title: "Migration Complete",
        description: "Your asset has been successfully migrated to Originals!",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Migration Failed",
        description: error.message || "Failed to migrate asset. Please try again.",
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

  const handleImportSubmit = (data: ImportFormData) => {
    setFormData(prev => ({ ...prev, ...data }));
    setAssetFound(true);
    handleNextStep();
  };

  const handleVerifySubmit = (data: VerifyFormData) => {
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
      assetType: "migrated",
      status: "completed",
    };
    migrateAssetMutation.mutate(finalData);
  };

  const handleBackToDashboard = () => {
    setLocation("/");
  };

  const handleMigrateAnother = () => {
    setShowSuccessModal(false);
    setCreatedAsset(null);
    setCurrentStep(1);
    setFormData({});
    setAssetFound(false);
    importForm.reset();
    verifyForm.reset();
    credentialsForm.reset();
  };

  const handleViewPortfolio = () => {
    setShowSuccessModal(false);
    setLocation("/");
  };

  const handleSearchAsset = () => {
    // Mock asset search - in real app would query blockchain
    const reference = importForm.getValues("originalReference");
    if (reference) {
      setAssetFound(true);
      importForm.setValue("title", `Ordinal #${reference.slice(-5)}`);
      importForm.setValue("description", "Existing Ordinal asset being migrated to Originals");
      toast({
        title: "Asset Found",
        description: "Original asset located and verified on blockchain.",
      });
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Header */}
      <div className="mb-12">
        <div className="flex items-center justify-center mb-6">
          <Button 
            variant="ghost" 
            onClick={handleBackToDashboard}
            className="text-neutral-600 hover:text-neutral-900"
            data-testid="back-to-dashboard"
          >
            <ArrowLeft className="mr-2 w-4 h-4" />
            Back to Dashboard
          </Button>
        </div>
        
        <ProgressIndicator 
          currentStep={currentStep} 
          totalSteps={4} 
          steps={steps} 
        />
      </div>

      {/* Step Content */}
      <div className="max-w-2xl mx-auto">
        {currentStep === 1 && (
          <Card>
            <CardHeader className="text-center">
              <CardTitle className="text-3xl font-bold text-neutral-900 mb-4">
                Import Existing Asset
              </CardTitle>
              <p className="text-lg text-neutral-600">
                Find your existing Ordinal or inscription to migrate
              </p>
            </CardHeader>
            <CardContent>
              <Form {...importForm}>
                <form onSubmit={importForm.handleSubmit(handleImportSubmit)} className="space-y-8">
                  <FormField
                    control={importForm.control}
                    name="originalReference"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Asset Reference *</FormLabel>
                        <div className="flex space-x-2">
                          <FormControl>
                            <Input
                              placeholder="Enter transaction ID, inscription ID, or asset reference"
                              {...field}
                              data-testid="asset-reference-input"
                            />
                          </FormControl>
                          <Button
                            type="button"
                            variant="outline"
                            onClick={handleSearchAsset}
                            data-testid="search-asset-button"
                          >
                            <Search className="w-4 h-4" />
                          </Button>
                        </div>
                        <FormDescription>
                          Provide the transaction ID or inscription ID of your existing asset
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {assetFound && (
                    <div className="bg-green-50 border border-green-200 rounded-xl p-6">
                      <div className="flex items-start space-x-3">
                        <div className="w-6 h-6 bg-green-100 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5">
                          <div className="w-2 h-2 bg-green-600 rounded-full"></div>
                        </div>
                        <div className="flex-1">
                          <h4 className="font-semibold text-green-900 mb-2">Asset Found!</h4>
                          <div className="space-y-2 text-sm text-green-800">
                            <div><strong>Type:</strong> Ordinal Inscription</div>
                            <div><strong>Block Height:</strong> 820,450</div>
                            <div><strong>Size:</strong> 2.4 KB</div>
                            <div><strong>Content Type:</strong> image/png</div>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  <FormField
                    control={importForm.control}
                    name="title"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Asset Title *</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="Enter a title for your migrated asset"
                            {...field}
                            data-testid="migrated-asset-title-input"
                          />
                        </FormControl>
                        <FormDescription>
                          This title will be used in the Originals protocol
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={importForm.control}
                    name="description"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Description</FormLabel>
                        <FormControl>
                          <Textarea
                            placeholder="Describe the asset and its significance..."
                            rows={4}
                            {...field}
                            data-testid="migrated-asset-description-input"
                          />
                        </FormControl>
                        <FormDescription>
                          Add context about this asset's history and importance
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <div className="flex justify-end pt-8">
                    <Button 
                      type="submit" 
                      className="btn-primary"
                      disabled={!assetFound}
                      data-testid="continue-to-verify"
                    >
                      Continue to Verification
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
                Verify Ownership
              </CardTitle>
              <p className="text-lg text-neutral-600">
                Prove you own this asset to proceed with migration
              </p>
            </CardHeader>
            <CardContent>
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-6 mb-8">
                <div className="flex items-start space-x-3">
                  <AlertTriangle className="w-6 h-6 text-amber-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <h4 className="font-semibold text-amber-900 mb-2">Ownership Verification Required</h4>
                    <p className="text-amber-800 text-sm">
                      To migrate this asset, you must prove ownership by signing a message with the wallet 
                      that controls the original asset.
                    </p>
                  </div>
                </div>
              </div>

              <Form {...verifyForm}>
                <form onSubmit={verifyForm.handleSubmit(handleVerifySubmit)} className="space-y-8">
                  <div className="bg-neutral-50 rounded-xl p-6">
                    <h4 className="font-semibold text-neutral-900 mb-4">Asset Details</h4>
                    <div className="space-y-2 text-sm">
                      <div className="flex justify-between">
                        <span className="text-neutral-600">Original Reference:</span>
                        <span className="font-mono text-neutral-900" data-testid="verify-reference">
                          {formData.originalReference}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-neutral-600">Current Owner:</span>
                        <span className="font-mono text-neutral-900">bc1q...7x9k</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-neutral-600">Connected Wallet:</span>
                        <span className="font-mono text-neutral-900">bc1q...7x9k</span>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-4">
                    <div className="bg-green-50 border border-green-200 rounded-xl p-4">
                      <div className="flex items-center space-x-2">
                        <div className="w-5 h-5 bg-green-100 rounded-full flex items-center justify-center">
                          <div className="w-2 h-2 bg-green-600 rounded-full"></div>
                        </div>
                        <span className="text-green-800 font-medium">Wallet addresses match</span>
                      </div>
                    </div>

                    <Button 
                      type="button"
                      variant="outline" 
                      className="w-full"
                      data-testid="sign-ownership-message"
                    >
                      Sign Ownership Message
                    </Button>
                  </div>

                  <FormField
                    control={verifyForm.control}
                    name="ownershipProof"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Signature *</FormLabel>
                        <FormControl>
                          <Textarea
                            placeholder="Paste the signed message here..."
                            rows={4}
                            {...field}
                            className="font-mono text-sm"
                            data-testid="ownership-signature-input"
                          />
                        </FormControl>
                        <FormDescription>
                          The cryptographic signature proving ownership of the original asset
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
                      data-testid="back-to-import"
                    >
                      <ArrowLeft className="mr-2 w-4 h-4" />
                      Back
                    </Button>
                    <Button type="submit" className="btn-primary" data-testid="continue-to-migrate-credentials">
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
                Enhanced Credentials
              </CardTitle>
              <p className="text-lg text-neutral-600">
                Add additional verification to your migrated asset
              </p>
            </CardHeader>
            <CardContent>
              <div className="space-y-6">
                <div className="bg-neutral-50 rounded-xl p-6">
                  <h4 className="font-semibold text-neutral-900 mb-3">Migration-Specific Credentials</h4>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between p-3 bg-white rounded-lg border">
                      <div>
                        <div className="font-medium text-neutral-900">Original Chain Proof</div>
                        <div className="text-sm text-neutral-600">Link to original blockchain transaction</div>
                      </div>
                      <Button variant="outline" size="sm" data-testid="add-chain-proof">
                        Add
                      </Button>
                    </div>
                    <div className="flex items-center justify-between p-3 bg-white rounded-lg border">
                      <div>
                        <div className="font-medium text-neutral-900">Migration History</div>
                        <div className="text-sm text-neutral-600">Document the migration process</div>
                      </div>
                      <Button variant="outline" size="sm" data-testid="add-migration-history">
                        Add
                      </Button>
                    </div>
                    <div className="flex items-center justify-between p-3 bg-white rounded-lg border">
                      <div>
                        <div className="font-medium text-neutral-900">Enhanced Metadata</div>
                        <div className="text-sm text-neutral-600">Additional asset information</div>
                      </div>
                      <Button variant="outline" size="sm" data-testid="add-enhanced-metadata">
                        Add
                      </Button>
                    </div>
                  </div>
                </div>

                <div className="text-center py-8 text-neutral-600">
                  <p className="mb-2">No additional credentials added</p>
                  <p className="text-sm">These credentials enhance the value and verifiability of your migrated asset</p>
                </div>

                <div className="flex justify-between pt-8">
                  <Button 
                    type="button" 
                    variant="outline" 
                    onClick={handlePrevStep}
                    data-testid="back-to-verify"
                  >
                    <ArrowLeft className="mr-2 w-4 h-4" />
                    Back
                  </Button>
                  <Button 
                    onClick={() => credentialsForm.handleSubmit(handleCredentialsSubmit)()}
                    className="btn-primary"
                    data-testid="continue-to-complete"
                  >
                    Complete Migration
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
                Complete Migration
              </CardTitle>
              <p className="text-lg text-neutral-600">
                Review and finalize your asset migration
              </p>
            </CardHeader>
            <CardContent>
              <div className="space-y-6">
                <div className="bg-neutral-50 rounded-xl p-6">
                  <h4 className="font-semibold text-neutral-900 mb-4">Migration Summary</h4>
                  <div className="space-y-3">
                    <div>
                      <div className="text-sm text-neutral-600">Original Asset</div>
                      <div className="font-mono text-sm text-neutral-900" data-testid="review-original-reference">
                        {formData.originalReference}
                      </div>
                    </div>
                    <div>
                      <div className="text-sm text-neutral-600">New Title</div>
                      <div className="font-medium text-neutral-900" data-testid="review-migrated-title">
                        {formData.title || "Untitled"}
                      </div>
                    </div>
                    {formData.description && (
                      <div>
                        <div className="text-sm text-neutral-600">Description</div>
                        <div className="text-neutral-900" data-testid="review-migrated-description">
                          {formData.description}
                        </div>
                      </div>
                    )}
                    <div>
                      <div className="text-sm text-neutral-600">Asset Type</div>
                      <div className="text-neutral-900">Migrated Ordinal</div>
                    </div>
                  </div>
                </div>

                <div className="bg-blue-50 border border-blue-200 rounded-xl p-6">
                  <h4 className="font-semibold text-blue-900 mb-2">Migration Benefits</h4>
                  <ul className="text-blue-800 text-sm space-y-1">
                    <li>• Enhanced metadata and credential support</li>
                    <li>• Improved discoverability in the Originals ecosystem</li>
                    <li>• Backward compatibility with original chain data</li>
                    <li>• Additional verification and authentication options</li>
                  </ul>
                </div>

                <div className="bg-amber-50 border border-amber-200 rounded-xl p-6">
                  <h4 className="font-semibold text-amber-900 mb-2">Important Note</h4>
                  <p className="text-amber-800 text-sm">
                    This migration will create a new entry in the Originals protocol while maintaining 
                    a verifiable link to your original asset. The original asset remains unchanged.
                  </p>
                </div>

                <div className="flex justify-between pt-8">
                  <Button 
                    type="button" 
                    variant="outline" 
                    onClick={handlePrevStep}
                    data-testid="back-to-migrate-credentials"
                  >
                    <ArrowLeft className="mr-2 w-4 h-4" />
                    Back
                  </Button>
                  <Button 
                    onClick={handleFinalSubmit}
                    disabled={migrateAssetMutation.isPending}
                    className="btn-primary"
                    data-testid="finalize-migration"
                  >
                    {migrateAssetMutation.isPending ? "Migrating..." : "Complete Migration"}
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
        onCreateAnother={handleMigrateAnother}
        onViewPortfolio={handleViewPortfolio}
      />
    </div>
  );
}
