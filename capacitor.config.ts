import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.app.resqit',
  appName: 'ResQ-It',
  webDir: 'dist/resq-it/browser',
  plugins: {
    Geolocation: {
      // Location is requested only when a user starts a nearby search.
    }
  }
};

export default config;
