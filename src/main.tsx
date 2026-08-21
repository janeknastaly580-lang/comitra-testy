import React from 'react';
import ReactDOM from 'react-dom/client';
// Fonts are bundled rather than fetched from Google's CDN: the Android build
// runs from file:// and is regularly offline, and a webfont that fails to load
// silently falls back to whatever the WebView happens to ship, which is exactly
// how an app ends up looking different on somebody else's phone.
import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/dm-sans/600.css';
import '@fontsource/dm-sans/700.css';
// Wordmark only — see src/components/Wordmark.tsx.
import '@fontsource/playfair-display/500.css';
// HashRouter keeps deep links working from file:// (Capacitor / Android WebView).
import { HashRouter } from 'react-router-dom';
import App from './App';
import { AppProvider } from './context/AppContext';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <AppProvider>
        <App />
      </AppProvider>
    </HashRouter>
  </React.StrictMode>,
);
