import { Switch, Route, useLocation } from "wouter";
import { queryClient, setGlobalGetAccessToken } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { PrivyProvider, usePrivy } from "@privy-io/react-auth";
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

function AuthSetup() {
  const { getAccessToken } = usePrivy();
  
  useEffect(() => {
    // Wrap getAccessToken to ensure it returns a string (never null for auth)
    const wrappedGetAccessToken = async () => {
      const token = await getAccessToken();
      return token || '';
    };
    setGlobalGetAccessToken(wrappedGetAccessToken);
  }, [getAccessToken]);
  
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
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <PrivyProvider 
      appId={import.meta.env.VITE_PRIVY_APP_ID}
      config={{
        appearance: {
          theme: 'light',
          accentColor: '#1f2937',
          logo: undefined,
        },
        loginMethods: ['email', 'wallet', 'google'],
      }}
    >
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
    </PrivyProvider>
  );
}

export default App;
