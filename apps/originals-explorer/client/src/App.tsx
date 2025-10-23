import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
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

/**
 * Main Router Component
 * Handles all application routes
 */
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

/**
 * Main App Component
 * Authentication via HTTP-only cookies (no client-side token management)
 * Turnkey integration on server-side for key management
 */
function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <div className="min-h-screen bg-background">
          <Header />
          <Toaster />
          <Router />
        </div>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
