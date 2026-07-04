/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output for Tauri bundling (doesn't affect dev server)
  output: 'standalone',

  // Exclude unnecessary files from standalone bundle
  outputFileTracingExcludes: {
    '*': [
      'src-tauri/**',
      // These two prevent a recursive self-copy: src-deno/standalone/ is the Deno
      // build's own previous output, and dist/ holds its packaged .app/.dmg. Without
      // these excludes, each non-clean build re-embeds the prior build's output inside
      // the new one, nesting one generation deeper every run (see docs/deno-vs-tauri.md
      // Task 5 findings for the ~1.99GB bloat bug this caused).
      'src-deno/standalone/**',
      'dist/**',
      '.git/**',
      'scripts/**',
      '*.md',
      '*.json',
      '!package.json',
    ],
  },
};

export default nextConfig;
