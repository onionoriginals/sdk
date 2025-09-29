import { useState } from "react";
import { useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { ArrowLeft, Upload } from "lucide-react";
import type { InsertAsset } from "../../../shared/schema";

const createAssetSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  category: z.string().min(1, "Category is required"),
  tags: z.string().optional(),
  mediaFile: z.instanceof(File).optional(),
});

export default function CreateAssetSimple() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isUploading, setIsUploading] = useState(false);

  const form = useForm<z.infer<typeof createAssetSchema>>({
    resolver: zodResolver(createAssetSchema),
    defaultValues: {
      title: "",
      description: "",
      category: "",
      tags: "",
    },
  });

  const createAssetMutation = useMutation({
    mutationFn: async (data: InsertAsset) => {
      return await apiRequest("/api/assets", "POST", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/assets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({
        title: "Success",
        description: "Asset created successfully",
      });
      setLocation("/dashboard");
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to create asset. Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleSubmit = (values: z.infer<typeof createAssetSchema>) => {
    setIsUploading(true);
    
    const assetData: InsertAsset = {
      title: values.title,
      description: values.description || "",
      category: values.category,
      tags: values.tags ? values.tags.split(",").map(tag => tag.trim()) : [],
      mediaUrl: values.mediaFile ? URL.createObjectURL(values.mediaFile) : "",
      metadata: {
        fileType: values.mediaFile?.type || "",
        fileSize: values.mediaFile?.size || 0,
      },
      userId: "user_123", // Mock user ID
      assetType: "original",
      status: "completed",
    };

    createAssetMutation.mutate(assetData);
    setIsUploading(false);
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

      <h1 className="page-title">Create Original</h1>
      
      <div className="bg-white border border-gray-200 rounded-sm p-8">
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

            <FormField
              control={form.control}
              name="mediaFile"
              render={({ field: { value, onChange, ...field } }) => (
                <FormItem>
                  <FormLabel className="text-sm font-medium text-gray-700">Media File</FormLabel>
                  <FormControl>
                    <div className="border-2 border-dashed border-gray-200 rounded-sm p-6 text-center hover:border-gray-300 transition-colors">
                      <input
                        {...field}
                        type="file"
                        accept="image/*,video/*,audio/*"
                        onChange={(e) => onChange(e.target.files?.[0])}
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
                          {value ? value.name : "Click to upload file"}
                        </span>
                      </label>
                    </div>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="pt-6 border-t border-gray-200">
              <button 
                type="submit" 
                disabled={isUploading || createAssetMutation.isPending}
                className="minimal-button w-full"
                data-testid="create-asset-button"
              >
                {isUploading || createAssetMutation.isPending ? "Creating..." : "Create Asset"}
              </button>
            </div>
          </form>
        </Form>
      </div>
    </main>
  );
}