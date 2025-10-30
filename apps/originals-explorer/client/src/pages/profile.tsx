import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { useTurnkeySession } from "@/contexts/TurnkeySessionContext";
import { apiRequest } from "@/lib/queryClient";
import { CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Mail, Settings, LogOut, Plus, Key, Shield, Copy, ChevronDown, ChevronUp, Download, Loader2 } from "lucide-react";
import { Link } from "wouter";
import { useState, useEffect } from "react";
import { signDIDDocument } from "@/lib/turnkey-signing";
import { getKeyByCurve } from "@/lib/turnkey-client";

export default function Profile() {
  const { user, isLoading, isAuthenticated, logout } = useAuth();
  const { toast } = useToast();
  const [did, setDid] = useState<string | null>(null);
  const [didDocument, setDidDocument] = useState<any>(null);
  const [didLoading, setDidLoading] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  const [qrCodeUrl, setQrCodeUrl] = useState<string | null>(null);

  // Turnkey session from login
  const turnkeySession = useTurnkeySession();

  // Enhanced logout that also clears Turnkey session
  const handleLogout = () => {
    turnkeySession.clearSession();
    logout();
  };

  // Clear DID state when user changes or logs out
  useEffect(() => {
    if (!isAuthenticated || !user) {
      setDid(null);
      setDidDocument(null);
      setQrCodeUrl(null);
      setShowKeys(false);
    }
  }, [isAuthenticated, user?.id]);

  // Check if user has DID when authenticated
  useEffect(() => {
    if (isAuthenticated && user && !did && !didLoading) {
      checkUserDid();
    }
  }, [isAuthenticated, user?.id]);

  const checkUserDid = async () => {
    setDidLoading(true);
    try {
      // Check if user has a real DID (not a temporary placeholder)
      const hasRealDid = user?.did && !user.did.startsWith('temp:');

      if (hasRealDid) {
        setDid(user.did);

        // Try to fetch DID document
        try {
          const res = await apiRequest("GET", "/api/did/me");
          const data = await res.json();
          if (data.didDocument) {
            setDidDocument(data.didDocument);

            // Generate QR code
            const qrRes = await apiRequest("POST", "/api/qr-code", {
              data: user.did,
            });
            const qrData = await qrRes.json();
            setQrCodeUrl(qrData.qrCode);
          }
        } catch (error) {
          console.error("Error fetching DID document:", error);
        }
      }
      // User doesn't have DID yet - they can create one using their existing login session
    } catch (error) {
      console.error("Error checking user DID:", error);
    } finally {
      setDidLoading(false);
    }
  };

  const handleCreateDid = async () => {
    // Must have a Turnkey session from login
    if (!turnkeySession.isAuthenticated || !turnkeySession.client || !turnkeySession.wallets?.length) {
      toast({
        title: "Not Authenticated",
        description: "Please log in first to create a DID",
        variant: "destructive",
      });
      return;
    }

    setDidLoading(true);
    try {
      const turnkeyClient = turnkeySession.client;
      const wallets = turnkeySession.wallets;

      toast({
        title: "Creating DID",
        description: "Using your Turnkey session...",
      });

      // Step 2: Get keys from Turnkey
      const authKey = getKeyByCurve(wallets, 'CURVE_SECP256K1');
      const assertionKey = getKeyByCurve(wallets, 'CURVE_ED25519');

      // Get second ED25519 key for update key
      const ed25519Keys = wallets.flatMap(wallet =>
        wallet.accounts.filter(account => account.curve === 'CURVE_ED25519')
      );
      const updateKey = ed25519Keys.length > 1 ? ed25519Keys[1] : null;

      if (!authKey || !assertionKey || !updateKey) {
        throw new Error("Failed to discover keys from Turnkey wallet");
      }

      console.log("Discovered keys:", {
        auth: authKey.address,
        assertion: assertionKey.address,
        update: updateKey.address,
      });

      // Step 3: Prepare DID document (get unsigned structure from backend)
      const prepareRes = await apiRequest("POST", "/api/did/prepare-document", {
        publicKeys: {
          auth: authKey.address, // Using addresses as public key identifiers
          assertion: assertionKey.address,
          update: updateKey.address,
        },
      });

      const prepareData = await prepareRes.json();
      const unsignedDidDocument = prepareData.didDocument;

      console.log("Prepared DID document:", unsignedDidDocument);

      // Step 4: Sign DID document with update key in browser
      if (!turnkeyClient) {
        throw new Error("Turnkey client not initialized");
      }

      const { signature, proofValue } = await signDIDDocument(
        turnkeyClient,
        unsignedDidDocument,
        updateKey
      );

      console.log("Signed DID document with signature:", signature);

      // Step 5: Send signed DID to backend for verification and storage
      const acceptRes = await apiRequest("POST", "/api/did/accept-signed", {
        didDocument: unsignedDidDocument,
        signature: proofValue,
        publicKey: updateKey.address,
      });

      const acceptData = await acceptRes.json();

      if (!acceptData.success) {
        throw new Error(acceptData.error || "Failed to accept signed DID");
      }

      // Success!
      setDid(acceptData.did);
      setDidDocument(unsignedDidDocument);

      toast({
        title: "DID Created",
        description: "Your decentralized identifier has been created and secured by Turnkey.",
      });

      // Generate QR code
      const qrRes = await apiRequest("POST", "/api/qr-code", {
        data: acceptData.did,
      });
      const qrData = await qrRes.json();
      setQrCodeUrl(qrData.qrCode);

    } catch (error: any) {
      console.error("Failed to create DID:", error);
      toast({
        title: "Failed to create DID",
        description: error?.message || "Please try again.",
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
      <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
        <div className="bg-white min-h-96 p-4 sm:p-6 flex items-center justify-center">
          <div className="text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
            <p className="mt-2 text-gray-600">Loading profile...</p>
          </div>
        </div>
      </main>
    );
  }

  if (!isAuthenticated || !user) {
    return (
      <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
        <div className="bg-white min-h-96 p-4 sm:p-6 flex items-center justify-center">
          <div className="text-center max-w-md mx-auto">
            <h2 className="text-2xl font-semibold text-gray-900 mb-2">Authentication Required</h2>
            <p className="text-gray-600 mb-6">
              Please sign in to view your profile
            </p>
            <Link href="/login">
              <Button data-testid="profile-login-button">
                Sign In
              </Button>
            </Link>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
      <div className="bg-white min-h-96 p-4 sm:p-6">
        <div className="max-w-2xl mx-auto">
          <CardContent className="p-0">
            {/* Header */}
            <div className="mb-6">
              <h2 className="text-3xl font-light text-gray-900" data-testid="profile-title">
                Account
              </h2>
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
                  <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
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
            ) : turnkeySession.isAuthenticated ? (
              // User has existing Turnkey session from login - show simple "Create DID" button
              <div className="mb-4">
                <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
                  <div className="flex items-start gap-3 mb-3">
                    <Shield className="w-5 h-5 text-blue-600 mt-0.5" />
                    <div className="flex-1">
                      <div className="text-sm font-semibold text-blue-900 mb-1">
                        Ready to Create Your Decentralized ID
                      </div>
                      <div className="text-xs text-blue-800 mb-3">
                        Your Turnkey session is active. Click below to create your DID with your own keys.
                      </div>
                      <Button
                        onClick={handleCreateDid}
                        disabled={didLoading}
                        className="w-full"
                        size="sm"
                        data-testid="profile-create-did-button"
                      >
                        {didLoading ? (
                          <>
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            Creating DID...
                          </>
                        ) : (
                          <>
                            <Shield className="w-4 h-4 mr-2" />
                            Create My DID
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              // User is not authenticated with Turnkey - ask them to log in
              <div className="mb-4">
                <div className="p-4 bg-yellow-50 rounded-lg border border-yellow-200">
                  <div className="flex items-start gap-3">
                    <Shield className="w-5 h-5 text-yellow-600 mt-0.5" />
                    <div className="flex-1">
                      <div className="text-sm font-semibold text-yellow-900 mb-1">
                        Turnkey Session Required
                      </div>
                      <div className="text-xs text-yellow-800 mb-3">
                        Please log in again to create your DID. Your session may have expired.
                      </div>
                      <Link href="/login?returnTo=/profile">
                        <Button
                          className="w-full"
                          size="sm"
                          variant="default"
                        >
                          Log In
                        </Button>
                      </Link>
                    </div>
                  </div>
                </div>
              </div>
            )}

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
                <span className="font-semibold text-gray-600">●&nbsp;turnkey</span>
              </div>
            </div>
          </CardContent>
        </div>
      </div>
    </main>
  );
}
