#!/usr/bin/env node
/**
 * Prepares the Next.js standalone build for the Deno desktop shell.
 * Assembles .next/standalone + static assets + data + .env.local
 * into src-deno/standalone/.
 */

import { cpSync, existsSync, rmSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const SRC = join(ROOT, '.next', 'standalone');
const DEST = join(ROOT, 'src-deno', 'standalone');

console.log('Preparing standalone build for Deno desktop...');

if (!existsSync(SRC)) {
  console.error('Error: .next/standalone not found. Run "npm run build" first.');
  process.exit(1);
}

if (existsSync(DEST)) rmSync(DEST, { recursive: true });
cpSync(SRC, DEST, { recursive: true });

const copies = [
  [join(ROOT, '.next', 'static'), join(DEST, '.next', 'static')],
  [join(ROOT, 'data'), join(DEST, 'data')],
  [join(ROOT, '.env.local'), join(DEST, '.env.local')],
];
for (const [from, to] of copies) {
  if (existsSync(from)) {
    console.log(`Copying ${from.replace(ROOT + '/', '')}...`);
    cpSync(from, to, { recursive: true });
  }
}

const toRemove = ['eslint.config.mjs', 'postcss.config.mjs', 'tailwind.config.js', 'LICENSE', 'src'];
for (const file of toRemove) {
  const path = join(DEST, file);
  if (existsSync(path)) rmSync(path, { recursive: true });
}

console.log('Done! src-deno/standalone ready.');
