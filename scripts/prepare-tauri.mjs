#!/usr/bin/env node
/**
 * Prepares the Next.js standalone build for Tauri bundling.
 * Copies static assets and data files to the standalone directory.
 */

import { cpSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const STANDALONE = join(ROOT, '.next', 'standalone');
const STATIC_SRC = join(ROOT, '.next', 'static');
const STATIC_DEST = join(STANDALONE, '.next', 'static');
const DATA_SRC = join(ROOT, 'data');
const DATA_DEST = join(STANDALONE, 'data');
const ENV_SRC = join(ROOT, '.env.local');
const ENV_DEST = join(STANDALONE, '.env.local');

console.log('Preparing standalone build for Tauri...');

// Check if standalone exists
if (!existsSync(STANDALONE)) {
  console.error('Error: .next/standalone not found. Run "npm run build" first.');
  process.exit(1);
}

// Copy static assets
if (existsSync(STATIC_SRC)) {
  console.log('Copying static assets...');
  if (existsSync(STATIC_DEST)) rmSync(STATIC_DEST, { recursive: true });
  cpSync(STATIC_SRC, STATIC_DEST, { recursive: true });
}

// Copy data folder
if (existsSync(DATA_SRC)) {
  console.log('Copying data folder...');
  if (existsSync(DATA_DEST)) rmSync(DATA_DEST, { recursive: true });
  cpSync(DATA_SRC, DATA_DEST, { recursive: true });
}

// Copy .env.local
if (existsSync(ENV_SRC)) {
  console.log('Copying .env.local...');
  cpSync(ENV_SRC, ENV_DEST);
}

// Clean up unnecessary files from standalone
const toRemove = [
  'eslint.config.mjs',
  'postcss.config.mjs',
  'tailwind.config.js',
  'LICENSE',
  'src',  // source files not needed at runtime
];

for (const file of toRemove) {
  const path = join(STANDALONE, file);
  if (existsSync(path)) {
    console.log(`Removing ${file}...`);
    rmSync(path, { recursive: true });
  }
}

console.log('Done! Standalone build ready for Tauri.');
