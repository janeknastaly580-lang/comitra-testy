import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor wraps the built web app (dist/) in a native Android shell.
 * The relative `base: './'` in vite.config.ts + HashRouter keep deep links
 * working from the file:// origin inside the Android WebView.
 */
const config: CapacitorConfig = {
  appId: 'com.fineline.app',
  appName: 'Comitra',
  webDir: 'dist',
  android: {
    // We serve our own bundled assets over https-like file access only; no
    // plaintext http content is loaded, which keeps the app store-compliant.
    allowMixedContent: false,
  },
};

export default config;
