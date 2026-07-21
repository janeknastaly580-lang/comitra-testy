import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base so the production build also works inside Capacitor / file:// (Android WebView).
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    // Bind to all interfaces so tunnels (ngrok) and LAN devices can reach the dev server.
    host: true,
    port: Number(process.env.PORT) || 5173,
    // Allow the Vite dev server to be served through these external hostnames.
    // The leading dot whitelists every subdomain (ngrok rotates the prefix each run).
    allowedHosts: ['.ngrok-free.dev', '.ngrok-free.app', '.ngrok.io', '.ngrok.app'],
  },
});
