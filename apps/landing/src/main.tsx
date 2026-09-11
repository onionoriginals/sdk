// Install browser globals before the application graph evaluates.
import './shims/buffer-global';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AuthProvider } from './auth/useAuth';
import '@fontsource-variable/inter';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './design/tokens.css';
import './design/global.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {new URLSearchParams(location.search).has('smoke')
      ? <App />
      : <AuthProvider><App /></AuthProvider>}
  </React.StrictMode>
);
