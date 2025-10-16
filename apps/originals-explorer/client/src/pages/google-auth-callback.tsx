import { useEffect, useState } from 'react';
import { Loader2, AlertCircle } from 'lucide-react';

export default function GoogleAuthCallback() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handleCallback = () => {
      try {
        const hash = window.location.hash;
        
        if (!hash.includes('access_token')) {
          setError('No access token received from Google');
          setTimeout(() => window.location.replace('/'), 2000);
          return;
        }

        // Extract token from hash
        const params = new URLSearchParams(hash.substring(1));
        const token = params.get('access_token');
        const expiresIn = params.get('expires_in');
        
        if (!token) {
          setError('Invalid token received');
          setTimeout(() => window.location.replace('/'), 2000);
          return;
        }

        // Calculate expiration time
        const expiresAt = Date.now() + (parseInt(expiresIn || '3600') * 1000);
        
        // Store token in sessionStorage
        sessionStorage.setItem('google_access_token', token);
        sessionStorage.setItem('google_token_expires_at', expiresAt.toString());
        
        // Get the return path (where user was before auth)
        const returnPath = sessionStorage.getItem('google_auth_return_path') || '/';
        sessionStorage.removeItem('google_auth_return_path');
        
        console.log('Token stored successfully, redirecting to:', returnPath);
        
        // Redirect back to original page
        window.location.replace(returnPath);
      } catch (err: any) {
        console.error('Error processing OAuth callback:', err);
        setError(err.message || 'Failed to process authentication');
        setTimeout(() => window.location.replace('/'), 2000);
      }
    };

    // Small delay to ensure DOM is ready
    setTimeout(handleCallback, 100);
  }, []);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <AlertCircle className="h-12 w-12 text-red-600 mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-gray-900 mb-2">
            Authentication Error
          </h2>
          <p className="text-gray-600 mb-4">
            {error}
          </p>
          <p className="text-sm text-gray-500">
            Redirecting to home...
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="text-center">
        <Loader2 className="h-12 w-12 animate-spin text-blue-600 mx-auto mb-4" />
        <h2 className="text-xl font-semibold text-gray-900 mb-2">
          Completing sign-in...
        </h2>
        <p className="text-gray-600">
          You'll be redirected shortly
        </p>
      </div>
    </div>
  );
}

