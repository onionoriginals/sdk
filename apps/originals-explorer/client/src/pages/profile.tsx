import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Mail, Settings, LogOut, X, Plus, Key, Shield, Copy, ChevronDown, ChevronUp, Download } from "lucide-react";
import { Link } from "wouter";
import { useState, useEffect } from "react";

export default function Profile() {
  const { toast } = useToast();
  const { user, isLoading: isAuthLoading, isUserLoading, isAuthenticated, logout: performLogout } = useAuth();
  const [did, setDid] = useState<string | null>(null);
  const [didDocument, setDidDocument] = useState<any>(null);
  const [didLoading, setDidLoading] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  const [qrCodeUrl, setQrCodeUrl] = useState<string | null>(null);

  const isLoading = isAuthLoading || isUserLoading;

  // Clear DID state when user changes or logs out
  useEffect(() => {
    if (!isAuthenticated || !user) {
      setDid(null);
      setDidDocument(null);
      setQrCodeUrl(null);
      setShowKeys(false);
    }
  }, [isAuthenticated, user?.id]);

  // Auto-create DID when user is authenticated
  useEffect(() => {
    if (isAuthenticated && user && !did && !didLoading) {
      ensureDid();
    }
  }, [isAuthenticated, user?.id]);

  const ensureDid = async () => {
    setDidLoading(true);
    try {
      const res = await apiRequest("POST", "/api/user/ensure-did");
      const data = await res.json();
      
      if (data.did) {
        setDid(data.did);
        setDidDocument(data.didDocument);
        
        if (data.created) {
          toast({
            title: "DID Created",
            description: "Your decentralized identifier has been created and secured by Turnkey.",
          });
        }

        // Generate QR code for the DID
        const qrRes = await apiRequest("POST", "/api/qr-code", {
          data: data.did,
        });
        const qrData = await qrRes.json();
        setQrCodeUrl(qrData.qrCode);
      }
    } catch (e: any) {
      console.error("Failed to ensure DID:", e);
      toast({
        title: "Failed to create DID",
        description: e?.message || "Please try again.",
        variant: "destructive",
      });
    } finally {
      setDidLoading(false);
    }
  };

  const copyDid = () => {
    if (did) {
      navigator.clipboard.writeText(did);
      toast({
        title: "Copied",
        description: "DID copied to clipboard",
      });
    }
  };

  const downloadDidDocument = () => {
    if (didDocument) {
      const blob = new Blob([JSON.stringify(didDocument, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "did-document.json";
      a.click();
      URL.revokeObjectURL(url);
      
      toast({
        title: "Downloaded",
        description: "DID document saved to your device",
      });
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-2 text-gray-600">Loading profile...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated || !user) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <CardTitle>Authentication Required</CardTitle>
            <CardDescription>
              Please sign in to view your profile
            </CardDescription>
          </CardHeader>
          <CardContent className="text-center">
            <Link href="/login">
              <Button data-testid="profile-login-button">
                Sign In
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  const handleLogout = async () => {
    await performLogout();
    window.location.href = "/";
  };

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Account Modal */}
        <Card className="bg-white shadow-lg border-0 rounded-2xl">
          <CardContent className="p-6">
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-semibold text-gray-900" data-testid="profile-title">
                Account
              </h2>
              <Link href="/">
                <button className="text-gray-400 hover:text-gray-600" data-testid="profile-close-button">
                  <X className="w-5 h-5" />
                </button>
              </Link>
            </div>

            {/* User Email */}
            <div className="flex items-center gap-3 mb-4 p-3 hover:bg-gray-50 rounded-lg transition-colors">
              <Mail className="w-4 h-4 text-gray-500" />
              <span className="text-sm text-gray-900" data-testid="profile-email-display">
                {user?.email || 'No email address'}
              </span>
            </div>

            {/* DID Section */}
            {didLoading ? (
              <div className="mb-4 p-3 bg-blue-50 rounded-lg">
                <div className="flex items-center gap-2">
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600"></div>
                  <span className="text-sm text-blue-900">Creating your DID...</span>
                </div>
              </div>
            ) : did ? (
              <div className="mb-4">
                <div className="p-3 bg-gradient-to-r from-blue-50 to-purple-50 rounded-lg border border-blue-200">
                  <div className="flex items-start gap-3 mb-3">
                    <Shield className="w-5 h-5 text-blue-600 mt-0.5" />
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-semibold text-blue-900">Decentralized ID</span>
                        <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">
                          Secured by Turnkey
                        </span>
                      </div>
                      <div className="font-mono text-xs text-gray-700 break-all mb-2" data-testid="profile-did">
                        {did}
                      </div>
                      <div className="flex gap-2 flex-wrap">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={copyDid}
                          className="text-xs h-7"
                          data-testid="profile-copy-did"
                        >
                          <Copy className="w-3 h-3 mr-1" />
                          Copy
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={downloadDidDocument}
                          className="text-xs h-7"
                          data-testid="profile-download-did"
                        >
                          <Download className="w-3 h-3 mr-1" />
                          Export
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setShowKeys(!showKeys)}
                          className="text-xs h-7"
                          data-testid="profile-toggle-keys"
                        >
                          <Key className="w-3 h-3 mr-1" />
                          Keys
                          {showKeys ? <ChevronUp className="w-3 h-3 ml-1" /> : <ChevronDown className="w-3 h-3 ml-1" />}
                        </Button>
                      </div>
                    </div>
                  </div>

                  {/* QR Code */}
                  {qrCodeUrl && (
                    <div className="mt-3 pt-3 border-t border-blue-200">
                      <div className="text-xs text-gray-600 mb-2">Scan to share your DID</div>
                      <img 
                        src={qrCodeUrl} 
                        alt="DID QR Code" 
                        className="w-32 h-32 mx-auto bg-white p-2 rounded"
                        data-testid="profile-did-qr"
                      />
                    </div>
                  )}

                  {/* Key Information */}
                  {showKeys && didDocument && (
                    <div className="mt-3 pt-3 border-t border-blue-200 space-y-2">
                      <div className="text-xs font-semibold text-gray-700 mb-2">Verification Methods</div>
                      
                      <div className="bg-white p-2 rounded border border-gray-200">
                        <div className="flex items-center gap-2 mb-1">
                          <Key className="w-3 h-3 text-orange-600" />
                          <span className="text-xs font-medium text-gray-700">Authentication Key</span>
                        </div>
                        <div className="text-xs text-gray-600 ml-5">
                          Type: Bitcoin (Secp256k1)
                        </div>
                        <div className="text-xs text-gray-500 ml-5 font-mono break-all mt-1">
                          {didDocument.verificationMethod?.[0]?.publicKeyMultibase?.slice(0, 20)}...
                        </div>
                      </div>

                      <div className="bg-white p-2 rounded border border-gray-200">
                        <div className="flex items-center gap-2 mb-1">
                          <Key className="w-3 h-3 text-blue-600" />
                          <span className="text-xs font-medium text-gray-700">Assertion Key</span>
                        </div>
                        <div className="text-xs text-gray-600 ml-5">
                          Type: Stellar (Ed25519)
                        </div>
                        <div className="text-xs text-gray-500 ml-5 font-mono break-all mt-1">
                          {didDocument.verificationMethod?.[1]?.publicKeyMultibase?.slice(0, 20)}...
                        </div>
                      </div>

                      <div className="text-xs text-gray-500 italic mt-2">
                        🔒 All private keys are securely managed by Turnkey
                      </div>
                      <div className="text-xs text-gray-500 italic">
                        ℹ️ Update key is managed separately in did.jsonl
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ) : null}

            {/* Settings */}
            <div className="flex items-center gap-3 mb-4 p-3 hover:bg-gray-50 rounded-lg transition-colors cursor-pointer">
              <Settings className="w-4 h-4 text-gray-500" />
              <span className="text-sm text-gray-900">Settings</span>
            </div>

            {/* Log out */}
            <div
              className="flex items-center gap-3 mb-6 p-3 hover:bg-gray-50 rounded-lg transition-colors cursor-pointer"
              onClick={handleLogout}
              data-testid="profile-logout-button"
            >
              <LogOut className="w-4 h-4 text-gray-500" />
              <span className="text-sm text-gray-900">Log out</span>
            </div>

            <Separator className="mb-6" />

            {/* Quick Actions */}
            <div className="space-y-2 mb-6">
              <Link href="/dir">
                <div className="flex items-center gap-3 p-3 hover:bg-gray-50 rounded-lg transition-colors cursor-pointer">
                  <Plus className="w-4 h-4 text-gray-500" />
                  <span className="text-sm text-gray-900" data-testid="profile-view-directory">
                    View Directory
                  </span>
                </div>
              </Link>
              
              <Link href="/create">
                <div className="flex items-center gap-3 p-3 hover:bg-gray-50 rounded-lg transition-colors cursor-pointer">
                  <Plus className="w-4 h-4 text-gray-500" />
                  <span className="text-sm text-gray-900" data-testid="profile-create-asset">
                    Create Asset
                  </span>
                </div>
              </Link>
            </div>

            {/* Protected by Turnkey */}
            <div className="text-center">
              <div className="text-xs text-gray-400 flex items-center justify-center gap-1">
                Protected by
                <span className="font-semibold text-gray-600">Turnkey</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}