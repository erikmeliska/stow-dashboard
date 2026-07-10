// src/lib/tech-tags.mjs
// Canonical technology tags derived deterministically from project metadata.
// The model only supplements via tech_extra, which is normalized here too.

// npm dependency -> canonical tag. Unknown deps are ignored on purpose:
// this is how "primary tech" is picked out of raw stack noise.
const DEP_TECH = {
  next: 'nextjs',
  react: 'react',
  'react-dom': 'react',
  'react-native': 'react-native',
  vue: 'vue',
  nuxt: 'nuxt',
  svelte: 'svelte',
  '@angular/core': 'angular',
  express: 'express',
  fastify: 'fastify',
  hono: 'hono',
  koa: 'koa',
  prisma: 'prisma',
  '@prisma/client': 'prisma',
  mongoose: 'mongodb',
  mongodb: 'mongodb',
  pg: 'postgres',
  mysql: 'mysql',
  mysql2: 'mysql',
  sqlite3: 'sqlite',
  'better-sqlite3': 'sqlite',
  redis: 'redis',
  ioredis: 'redis',
  tailwindcss: 'tailwind',
  typescript: 'typescript',
  electron: 'electron',
  tauri: 'tauri',
  '@tauri-apps/api': 'tauri',
  puppeteer: 'puppeteer',
  playwright: 'playwright',
  '@playwright/test': 'playwright',
  '@modelcontextprotocol/sdk': 'mcp',
  openai: 'openai',
  '@anthropic-ai/sdk': 'anthropic',
  ai: 'ai-sdk',
  firebase: 'firebase',
  'firebase-admin': 'firebase',
  stripe: 'stripe',
  '@supabase/supabase-js': 'supabase',
  'socket.io': 'websockets',
  ws: 'websockets',
  graphql: 'graphql',
  '@apollo/client': 'graphql',
  jest: 'jest',
  vitest: 'vitest',
  gatsby: 'gatsby',
  astro: 'astro',
  vite: 'vite',
  webpack: 'webpack',
  docker: 'docker',
}

// exact top-level file name -> tag
const FILE_TECH = {
  Dockerfile: 'docker',
  'docker-compose.yml': 'docker',
  'docker-compose.yaml': 'docker',
  'compose.yml': 'docker',
  'fly.toml': 'fly',
  'vercel.json': 'vercel',
  'netlify.toml': 'netlify',
  'platformio.ini': 'platformio',
  'requirements.txt': 'python',
  'pyproject.toml': 'python',
  'Pipfile': 'python',
  'composer.json': 'php',
  'Cargo.toml': 'rust',
  'go.mod': 'go',
  'deno.json': 'deno',
  'deno.jsonc': 'deno',
  'tauri.conf.json': 'tauri',
  'next.config.js': 'nextjs',
  'next.config.mjs': 'nextjs',
  'next.config.ts': 'nextjs',
  'manifest.json': 'browser-extension',
}

// file extension (from file_types keys) -> tag
const EXT_TECH = {
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.php': 'php',
  '.rs': 'rust',
  '.swift': 'swift',
  '.ino': 'arduino',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.go': 'go',
  '.kt': 'kotlin',
  '.java': 'java',
  '.c': 'c',
  '.cpp': 'cpp',
  '.rb': 'ruby',
}

const SYNONYMS = {
  'next.js': 'nextjs',
  next: 'nextjs',
  'node.js': 'node',
  nodejs: 'node',
  postgresql: 'postgres',
  tailwindcss: 'tailwind',
  'react.js': 'react',
  reactjs: 'react',
  'vue.js': 'vue',
  vuejs: 'vue',
  'docker-compose': 'docker',
  dockercompose: 'docker',
  'esp-32': 'esp32',
  'socket.io': 'websockets',
}

export function normalizeTech(tags) {
  const out = new Set()
  for (const raw of tags || []) {
    if (typeof raw !== 'string') continue
    let tag = raw.trim().toLowerCase().replace(/\s+/g, '-')
    if (!tag) continue
    // Reject prose the model sometimes emits as a "tech" (e.g.
    // "gitlab-api-for-data-fetching."): strip trailing punctuation, then drop
    // anything with stray characters or too many hyphen segments. Real techs
    // like react-native, socket.io, c++, c#, esp32 have <=2 segments and only
    // [a-z0-9.+#-]. (Brief prose said ">3 segments"; its own required cases
    // — seaborn-for-visualization, 3 segments — need the >2 threshold used here.)
    tag = tag.replace(/[.,;:]+$/, '')
    if (!tag) continue
    if (/[^a-z0-9.+#-]/.test(tag)) continue
    if (tag.split('-').length > 2) continue
    tag = SYNONYMS[tag] || tag
    out.add(tag)
  }
  return [...out].sort()
}

export function extractTech(project, topLevelNames = []) {
  const tags = []
  for (const dep of project?.stack || []) {
    if (DEP_TECH[dep]) tags.push(DEP_TECH[dep])
  }
  for (const ext of Object.keys(project?.file_types || {})) {
    if (EXT_TECH[ext]) tags.push(EXT_TECH[ext])
  }
  for (const name of topLevelNames) {
    if (FILE_TECH[name]) tags.push(FILE_TECH[name])
  }
  return normalizeTech(tags)
}
