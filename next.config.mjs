/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output for Tauri bundling (doesn't affect dev server)
  output: 'standalone',

  // Exclude unnecessary files from standalone bundle
  outputFileTracingExcludes: {
    '*': [
      'src-tauri/**',
      '.git/**',
      'scripts/**',
      '*.md',
      '*.json',
      '!package.json',
    ],
  },
};

export default nextConfig;
