import type { ExpoConfig } from 'expo/config';

/**
 * Expo app configuration. EXPO_PUBLIC_API_URL is read at runtime by the tRPC
 * client; it is safe to expose (no secrets).
 */
const config: ExpoConfig = {
  name: 'Horizon Trade',
  slug: 'horizon-trade',
  version: '2.0.0',
  orientation: 'portrait',
  scheme: 'horizontrade',
  userInterfaceStyle: 'dark',
  backgroundColor: '#0A0A0F',
  newArchEnabled: true,
  splash: {
    backgroundColor: '#0A0A0F',
    resizeMode: 'contain',
  },
  ios: {
    supportsTablet: true,
    bundleIdentifier: 'com.horizonholdings.trade',
  },
  android: {
    package: 'com.horizonholdings.trade',
    adaptiveIcon: {
      backgroundColor: '#0A0A0F',
    },
  },
  plugins: ['expo-router', 'expo-secure-store', 'expo-font'],
  experiments: {
    typedRoutes: true,
  },
  extra: {
    apiUrl: process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000',
  },
};

export default config;
