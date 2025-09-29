import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Check, Share, Eye, Plus } from "lucide-react";
import { generateQRCode, generateShareableLink } from "@/lib/qr-generator";
import { useToast } from "@/hooks/use-toast";
import type { Asset } from "@shared/schema";

interface SuccessModalProps {
  isOpen: boolean;
  onClose: () => void;
  asset: Asset | null;
  onCreateAnother?: () => void;
  onViewPortfolio?: () => void;
}

export function SuccessModal({ 
  isOpen, 
  onClose, 
  asset, 
  onCreateAnother, 
  onViewPortfolio 
}: SuccessModalProps) {
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [isGeneratingQR, setIsGeneratingQR] = useState(false);
  const { toast } = useToast();

  const handleShare = async () => {
    if (!asset) return;

    try {
      const shareLink = generateShareableLink(asset.id);
      
      // Try native sharing first
      if (navigator.share) {
        await navigator.share({
          title: `Original Asset: ${asset.title}`,
          text: `Check out this authenticated digital asset on Originals`,
          url: shareLink,
        });
      } else {
        // Fallback to clipboard
        await navigator.clipboard.writeText(shareLink);
        toast({
          title: "Link Copied",
          description: "The shareable link has been copied to your clipboard.",
        });
      }
    } catch (error) {
      console.error("Error sharing asset:", error);
      toast({
        title: "Share Failed",
        description: "Failed to share the asset. Please try again.",
        variant: "destructive",
      });
    }
  };

  const handleGenerateQR = async () => {
    if (!asset || qrCode) return;

    try {
      setIsGeneratingQR(true);
      const shareLink = generateShareableLink(asset.id);
      const qrCodeData = await generateQRCode(shareLink);
      setQrCode(qrCodeData);
    } catch (error) {
      console.error("Error generating QR code:", error);
      toast({
        title: "QR Generation Failed",
        description: "Failed to generate QR code. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsGeneratingQR(false);
    }
  };

  if (!asset) return null;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-md w-full" data-testid="success-modal">
        <DialogHeader className="text-center">
          <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-6">
            <Check className="text-green-600 w-8 h-8" />
          </div>
          <DialogTitle className="text-2xl font-bold text-neutral-900 mb-4">
            Asset Created Successfully!
          </DialogTitle>
          <p className="text-neutral-600 mb-8">
            Your digital asset has been authenticated and minted as an Original.
          </p>
        </DialogHeader>

        <div className="bg-neutral-50 rounded-xl p-4 mb-6">
          <div className="text-sm text-neutral-600 mb-2">Asset ID</div>
          <div 
            className="font-mono text-sm bg-white px-3 py-2 rounded-lg border break-all"
            data-testid="asset-id"
          >
            {asset.id}
          </div>
        </div>

        <div className="space-y-3">
          <Button
            onClick={handleShare}
            className="w-full btn-primary"
            data-testid="share-asset-button"
          >
            <Share className="w-4 h-4 mr-2" />
            Share Asset
          </Button>

          {!qrCode ? (
            <Button
              onClick={handleGenerateQR}
              disabled={isGeneratingQR}
              variant="outline"
              className="w-full"
              data-testid="generate-qr-button"
            >
              {isGeneratingQR ? "Generating..." : "Generate QR Code"}
            </Button>
          ) : (
            <div className="bg-white p-4 rounded-lg border text-center">
              <img 
                src={qrCode} 
                alt="Asset QR Code" 
                className="w-32 h-32 mx-auto"
                data-testid="asset-qr-code"
              />
              <p className="text-sm text-neutral-600 mt-2">Scan to view asset</p>
            </div>
          )}

          <Button
            onClick={onViewPortfolio}
            variant="outline"
            className="w-full"
            data-testid="view-portfolio-button"
          >
            <Eye className="w-4 h-4 mr-2" />
            View in Portfolio
          </Button>

          <Button
            onClick={onCreateAnother}
            variant="ghost"
            className="w-full text-neutral-600 hover:text-neutral-900"
            data-testid="create-another-button"
          >
            <Plus className="w-4 h-4 mr-2" />
            Create Another Asset
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
