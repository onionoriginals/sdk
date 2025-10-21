import { Switch, Route, useLocation } from "wouter";
import { queryClient, setGlobalGetAccessToken } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { TurnkeyProvider } from "@turnkey/sdk-react";
import { useEffect, useRef } from "react";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Header from "@/components/layout/header";
import Homepage from "@/pages/homepage";
import Directory from "@/pages/directory";
import Dashboard from "@/pages/dashboard";
import CreateAsset from "@/pages/create-asset-simple";
import MigrateAsset from "@/pages/migrate-asset-simple";
import Profile from "@/pages/profile";
import Login from "@/pages/login";
import Register from "@/pages/register";
import NotFound from "@/pages/not-found";
import AssetsSpreadsheet from "@/pages/assets-spreadsheet";
import Setup from "@/pages/setup";
import UploadAssets from "@/pages/upload-assets";
import GoogleCallback from "@/pages/google-callback";

function AuthSetup() {
  // For Turnkey, we'll set up the access token retrieval differently
  // This will be implemented in the useAuth hook
  useEffect(() => {
    // Get token from localStorage or session storage
    const getAccessToken = async () => {
      return localStorage.getItem('turnkey_token') || '';
    };
    setGlobalGetAccessToken(getAccessToken);
  }, []);

  return null;
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={Homepage} />
      <Route path="/dir" component={Directory} />
      <Route path="/assets" component={AssetsSpreadsheet} />
      <Route path="/setup" component={Setup} />
      <Route path="/profile" component={Profile} />
      <Route path="/login" component={Login} />
      <Route path="/register" component={Register} />
      <Route path="/dashboard" component={Dashboard} />
      <Route path="/create" component={CreateAsset} />
      <Route path="/migrate" component={MigrateAsset} />
      <Route path="/upload-assets" component={UploadAssets} />
      <Route path="/auth/google/callback" component={GoogleCallback} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  const turnkeyConfig = {
    apiBaseUrl: "https://api.turnkey.com",
    defaultOrganizationId: import.meta.env.VITE_TURNKEY_ORGANIZATION_ID,
    // rpId and serverSignUrl would be configured for production
    // For now, we'll handle auth manually in the login page
  };

  return (
    <TurnkeyProvider config={turnkeyConfig}>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <AuthSetup />
          <div className="min-h-screen bg-background">
            <Header />
            <Toaster />
            <Router />
          </div>
        </TooltipProvider>
      </QueryClientProvider>
    </TurnkeyProvider>
  );
}

export default App;
