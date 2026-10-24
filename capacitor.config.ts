import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.qoder.toolbox',
  appName: '全能工具箱',
  webDir: 'dist',
  android: {
    allowMixedContent: false,
    applicationId: 'com.qoder.toolbox',
  },
  server: { androidScheme: 'https' },
};

export default config;
