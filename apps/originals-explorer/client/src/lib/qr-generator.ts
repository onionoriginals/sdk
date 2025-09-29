import { apiRequest } from "./queryClient";

export const generateQRCode = async (data: string): Promise<string> => {
  try {
    const response = await apiRequest("POST", "/api/qr-code", { data });
    const result = await response.json();
    return result.qrCode;
  } catch (error) {
    console.error("Error generating QR code:", error);
    throw new Error("Failed to generate QR code");
  }
};

export const generateShareableLink = (assetId: string): string => {
  const baseUrl = typeof window !== 'undefined' 
    ? window.location.origin 
    : 'https://your-originals-app.com';
  return `${baseUrl}/asset/${assetId}`;
};
