import { useState, useEffect } from 'react';

interface UseGoogleAuthReturn {
  accessToken: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  login: () => void;
  logout: () => void;
}

export function useGoogleAuth(): UseGoogleAuthReturn {
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Check for existing token on mount
  useEffect(() => {
    const storedToken = sessionStorage.getItem('google_access_token');
    const expiresAt = sessionStorage.getItem('google_token_expires_at');
    
    if (storedToken && expiresAt) {
      const now = Date.now();
      if (now < parseInt(expiresAt)) {
        setAccessToken(storedToken);
        setIsAuthenticated(true);
      } else {
        // Token expired, clear it
        sessionStorage.removeItem('google_access_token');
        sessionStorage.removeItem('google_token_expires_at');
      }
    }
    
    setIsLoading(false);
  }, []);

  const login = () => {
    const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
    
    if (!clientId) {
      setError('Google Client ID not configured. Please add VITE_GOOGLE_CLIENT_ID to .env.local');
      return;
    }

    // Use a dedicated callback path that matches Google Cloud Console configuration
    const redirectUri = `${window.location.origin}/auth/google/callback`;
    const scope = [
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/drive.metadata.readonly'
    ].join(' ');

    // Store the original path to redirect back after auth
    sessionStorage.setItem('google_auth_return_path', window.location.pathname);

    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
      `client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&response_type=token` +
      `&scope=${encodeURIComponent(scope)}` +
      `&include_granted_scopes=true`;

    window.location.href = authUrl;
  };

  const logout = () => {
    sessionStorage.removeItem('google_access_token');
    sessionStorage.removeItem('google_token_expires_at');
    setAccessToken(null);
    setIsAuthenticated(false);
  };

  return {
    accessToken,
    isAuthenticated,
    isLoading,
    error,
    login,
    logout,
  };
}

