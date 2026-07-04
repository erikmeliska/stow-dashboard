/**
 * Starts the Next.js standalone server in-process (Deno Node compat) on PORT.
 *
 * The app resolves data/projects_metadata.jsonl and .env.local via
 * process.cwd() (see src/lib/projects.js), and the scan API writes back to
 * cwd. A compiled binary's embedded VFS may be read-only, so on startup we
 * sync writable state to ~/Library/Application Support/StowDashboardDeno.
 *
 * cwd split does NOT work: Next.js standalone's server.js calls
 * process.chdir(__dirname) itself on startup (baked into the generated
 * output), which overrides any chdir we do beforehand — verified empirically
 * (POST /api/scan wrote to src-deno/standalone/data/... instead of the
 * app-data dir even though we chdir'd there first). So instead we leave cwd
 * alone (Next.js will force it to STANDALONE_DIR regardless) and symlink
 * STANDALONE_DIR/data -> the writable app-data dir's data/, after removing
 * the bundled copy. See docs/deno-vs-tauri.md "Node API compatibility notes"
 * for the record of which variant works.
 */

import { copy, exists } from "jsr:@std/fs@1";
import { join } from "jsr:@std/path@1";

export const PORT = 3087;
export const BASE_URL = `http://localhost:${PORT}`;

const STANDALONE_DIR = new URL("./standalone/", import.meta.url).pathname;

function appDataDir(): string {
  const home = Deno.env.get("HOME") ?? ".";
  return join(home, "Library", "Application Support", "StowDashboardDeno");
}

function loadEnvFile(path: string): Record<string, string> {
  const vars: Record<string, string> = {};
  let content: string;
  try {
    content = Deno.readTextFileSync(path);
  } catch {
    return vars;
  }
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const pos = line.indexOf("=");
    if (pos === -1) continue;
    vars[line.slice(0, pos).trim()] = line.slice(pos + 1).trim();
  }
  return vars;
}

/**
 * First run: seed writable state (data/, .env.local) into the app-data dir,
 * then symlink STANDALONE_DIR/data -> app-data dir's data/ so Next.js
 * (which forces cwd === STANDALONE_DIR via its own process.chdir(__dirname))
 * still reads/writes the writable copy instead of the bundle.
 */
async function prepareWritableAppData(): Promise<string> {
  const dir = appDataDir();
  await Deno.mkdir(dir, { recursive: true });

  const appDataData = join(dir, "data");
  if (!(await exists(appDataData))) {
    if (await exists(join(STANDALONE_DIR, "data"))) {
      await copy(join(STANDALONE_DIR, "data"), appDataData);
    } else {
      await Deno.mkdir(appDataData, { recursive: true });
    }
  }

  if (!(await exists(join(dir, ".env.local")))) {
    if (await exists(join(STANDALONE_DIR, ".env.local"))) {
      await copy(join(STANDALONE_DIR, ".env.local"), join(dir, ".env.local"));
    }
  }

  // Replace the bundled data/ with a symlink to the writable app-data copy,
  // unless it's already correctly linked (e.g. a prior run set this up).
  const standaloneData = join(STANDALONE_DIR, "data");
  const standaloneDataInfo = await Deno.lstat(standaloneData).catch(() => null);
  if (!standaloneDataInfo?.isSymlink) {
    if (standaloneDataInfo) {
      await Deno.remove(standaloneData, { recursive: true });
    }
    await Deno.symlink(appDataData, standaloneData, { type: "dir" });
  }

  return dir;
}

export async function startServer(): Promise<void> {
  const appData = await prepareWritableAppData();

  const env = loadEnvFile(join(appData, ".env.local"));
  for (const [key, value] of Object.entries(env)) Deno.env.set(key, value);
  Deno.env.set("PORT", String(PORT));
  Deno.env.set("HOSTNAME", "localhost");

  console.error(`[Stow/Deno] app-data dir=${appData}`);
  console.error(`[Stow/Deno] starting standalone server from ${STANDALONE_DIR}`);
  console.error(`[Stow/Deno] (Next.js forces cwd=${STANDALONE_DIR} via its own process.chdir(__dirname); data/ is symlinked to app-data dir)`);

  // Next.js standalone entrypoint; runs under Deno's Node compat layer.
  // It calls process.chdir(__dirname) itself, so we don't chdir beforehand.
  await import(join(STANDALONE_DIR, "server.js"));
}

export async function waitForServer(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      await res.body?.cancel();
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return false;
}

if (import.meta.main) {
  await startServer();
  const ok = await waitForServer(BASE_URL, 15000);
  console.error(ok ? `[Stow/Deno] server ready at ${BASE_URL}` : "[Stow/Deno] server did not start");
}
