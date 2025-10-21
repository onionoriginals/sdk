import { useState, useEffect } from 'react';

export function useGoogleAuth() {
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const login = () => {
    const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
    
    if (!clientId) {
      setError('Google Client ID not configured');
      return;
    }

    const redirectUri = `${window.location.origin}/auth/google/callback`;
    const scope = 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.metadata.readonly';

    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
      `client_id=${clientId}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&response_type=token` +
      `&scope=${encodeURIComponent(scope)}` +
      `&prompt=consent`;

    console.log('[useGoogleAuth] Redirecting to Google OAuth with redirect_uri:', redirectUri);
    
    // Set a flag to indicate we should auto-open picker after auth
    sessionStorage.setItem('google_auth_should_open_picker', 'true');
    
    window.location.href = authUrl;
  };

  const logout = () => {
    setAccessToken(null);
    setIsAuthenticated(false);
    sessionStorage.removeItem('google_access_token');
    setError(null);
  };

  useEffect(() => {
    const initAuth = async () => {
      try {
        setIsLoading(true);
        
        // Check if we have a token in the URL hash (from OAuth redirect)
        const hash = window.location.hash;
        if (hash.includes('access_token')) {
          console.log('Found access_token in URL hash, processing...');
          const params = new URLSearchParams(hash.substring(1));
          const token = params.get('access_token');
          if (token) {
            console.log('Storing Google access token');
            setAccessToken(token);
            setIsAuthenticated(true);
            // Store in sessionStorage
            sessionStorage.setItem('google_access_token', token);
            // Clean up URL (remove hash)
            window.history.replaceState({}, document.title, window.location.pathname);
          }
        } else {
          // Check sessionStorage for existing token
          const storedToken = sessionStorage.getItem('google_access_token');
          if (storedToken) {
            console.log('Found stored Google access token');
            setAccessToken(storedToken);
            setIsAuthenticated(true);
          }
        }
      } catch (err: any) {
        setError(err.message || 'Authentication failed');
        console.error('Google auth error:', err);
      } finally {
        setIsLoading(false);
      }
    };

    initAuth();
  }, []);

  return { 
    accessToken, 
    isAuthenticated, 
    isLoading, 
    error, 
    login, 
    logout 
  };
}

