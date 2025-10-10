import { useState } from "react";
import { useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { ArrowLeft, Link as LinkIcon } from "lucide-react";
import type { InsertAsset } from "../../../shared/schema";

const migrateAssetSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  originalUrl: z.string().url("Please enter a valid URL").min(1, "Original URL is required"),
  transactionId: z.string().min(1, "Transaction ID is required"),
});

export default function MigrateAssetSimple() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isMigrating, setIsMigrating] = useState(false);

  const form = useForm<z.infer<typeof migrateAssetSchema>>({
    resolver: zodResolver(migrateAssetSchema),
    defaultValues: {
      title: "",
      description: "",
      originalUrl: "",
      transactionId: "",
    },
  });

  const migrateAssetMutation = useMutation({
    mutationFn: async (data: InsertAsset) => {
      return await apiRequest("/api/assets", "POST", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ predicate: (query) => 
        query.queryKey[0] === "/api/assets" || query.queryKey[0]?.toString().startsWith("/api/assets?")
      });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({
        title: "Success",
        description: "Asset migrated successfully",
      });
      setLocation("/dashboard");
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to migrate asset. Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleSubmit = (values: z.infer<typeof migrateAssetSchema>) => {
    setIsMigrating(true);
    
    const assetData: InsertAsset = {
      title: values.title,
      description: values.description || "",
      category: "migrated",
      tags: ["migrated", "ordinal"],
      mediaUrl: values.originalUrl,
      metadata: {
        originalUrl: values.originalUrl,
        transactionId: values.transactionId,
        migrationType: "ordinal",
      },
      userId: "user_123", // Mock user ID
      assetType: "migrated",
      status: "completed",
    };

    migrateAssetMutation.mutate(assetData);
    setIsMigrating(false);
  };

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

      <h1 className="page-title">Migrate to Original</h1>
      
      <div className="bg-white border border-gray-200 rounded-sm p-8">
        <div className="mb-8">
          <p className="text-gray-500 text-sm">
            Import an existing Ordinal or inscription by providing its details and transaction information.
          </p>
        </div>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-6">
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

            <FormField
              control={form.control}
              name="originalUrl"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-sm font-medium text-gray-700">Original URL</FormLabel>
                  <FormControl>
                    <div className="relative">
                      <LinkIcon className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
                      <Input
                        placeholder="https://ordinals.com/inscription/..."
                        {...field}
                        className="pl-10 border-gray-200 focus:border-gray-400 rounded-sm"
                        data-testid="original-url-input"
                      />
                    </div>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="transactionId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-sm font-medium text-gray-700">Transaction ID</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="Bitcoin transaction ID"
                      {...field}
                      className="border-gray-200 focus:border-gray-400 rounded-sm font-mono text-xs"
                      data-testid="transaction-id-input"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="pt-6 border-t border-gray-200">
              <button 
                type="submit" 
                disabled={isMigrating || migrateAssetMutation.isPending}
                className="minimal-button w-full"
                data-testid="migrate-asset-button"
              >
                {isMigrating || migrateAssetMutation.isPending ? "Migrating..." : "Migrate Asset"}
              </button>
            </div>
          </form>
        </Form>
      </div>
    </main>
  );
}