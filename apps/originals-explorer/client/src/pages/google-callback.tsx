import { useEffect } from 'react';
import { Loader2 } from 'lucide-react';

/**
 * Google OAuth Callback Page
 * 
 * This page handles the OAuth redirect from Google for the Google Drive import feature.
 * The access token is in the URL hash fragment. We immediately redirect to dashboard,
 * preserving the hash so useGoogleAuth can pick it up there.
 */
export default function GoogleCallback() {
  useEffect(() => {
    console.log('[GoogleCallback] Page loaded, redirecting to dashboard...');
    
    // Redirect immediately to dashboard, preserving the hash
    // Using replace() to avoid adding to browser history
    const hash = window.location.hash;
    window.location.replace('/dashboard' + hash);
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-center space-y-4">
        <Loader2 className="h-8 w-8 animate-spin text-primary mx-auto" />
        <div className="text-lg font-medium">Connecting to Google Drive...</div>
        <div className="text-sm text-muted-foreground">
          Redirecting...
        </div>
      </div>
    </div>
  );
}

