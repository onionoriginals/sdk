import { Switch, Route, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { useRef } from "react";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { OriginalsLayout } from "@/components/layout/originals-layout";
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
import AssetDetail from "@/pages/asset-detail";

function Router() {
  return (
    <Switch>
      <Route path="/">
        <OriginalsLayout>
          <Homepage />
        </OriginalsLayout>
      </Route>
      <Route path="/asset/:id">
        <OriginalsLayout>
          <AssetDetail />
        </OriginalsLayout>
      </Route>
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

function AppContent() {
  const [location] = useLocation();
  // Don't show header on routes that use OriginalsLayout (has sidebar)
  const routesWithSidebar = ['/', '/asset'];
  const showHeader = !routesWithSidebar.some(route =>
    location === route || location.startsWith(route + '/')
  );

  return (
    <div className="min-h-screen bg-background">
      {showHeader && <Header />}
      <Toaster />
      <Router />
    </div>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AppContent />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
