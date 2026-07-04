/**
 * Starts the Next.js standalone server in-process (Deno Node compat) on PORT.
 *
 * The app resolves data/projects_metadata.jsonl and .env.local via
 * process.cwd() (see src/lib/projects.js and several src/app/api/* routes),
 * and the scan API writes back to cwd. A compiled binary's embedded VFS may
 * be read-only, so on startup we sync writable state to
 * ~/Library/Application Support/StowDashboardDeno.
 *
 * Two things Next.js standalone's server.js does that we must work around:
 *
 * 1. It calls process.chdir(__dirname) itself on startup (baked into the
 *    generated output), which would reset cwd back to STANDALONE_DIR.
 * 2. It also *preloads* route modules (experimental.preloadEntriesOnStart)
 *    during that same synchronous startup window, so their module-level
 *    `path.join(process.cwd(), ...)` constants (e.g. src/app/api/scan/
 *    route.js's SYNC_FILE) are evaluated immediately — before our own code
 *    can regain control after the import.
 *
 * Together this means neither "chdir before import" nor "chdir after import
 * resolves" works on its own: the former is silently undone by Next's own
 * chdir(__dirname), and the latter is too late for the preloaded route
 * modules. The fix (see startServer() below): `Deno.chdir()` to the writable
 * app-data dir *before* importing server.js, and simultaneously neutralize
 * `process.chdir` to a no-op so Next's own chdir(__dirname) call can't undo
 * it. Next's asset resolution (serving .next/static, etc.) uses the `dir` it
 * was constructed with, not process.cwd(), so pinning cwd like this doesn't
 * break static asset serving.
 *
 * We previously tried leaving cwd alone and symlinking
 * STANDALONE_DIR/data -> the writable app-data dir instead. That works
 * under `deno run`, but fails under the *compiled* `deno desktop` app:
 * STANDALONE_DIR resolves inside deno's self-extracted VFS temp dir
 * (.../deno-compile-<binary>/src-deno/standalone/), and Deno.symlink()
 * throws `NotSupported` there — that overlay filesystem doesn't support
 * creating symlinks. Pinning cwd via chdir+no-op patch avoids touching
 * STANDALONE_DIR/data entirely, so it works in both `deno run` and the
 * compiled app. See docs/deno-vs-tauri.md "Node API compatibility notes"
 * (Task 4 findings) for the full record.
 *
 * Port handling: under compiled `deno desktop`, the runtime unconditionally
 * intercepts server listen() calls (including Node-compat's http.Server,
 * which Next's standalone server.js uses) and redirects them to its own
 * auto-assigned address, exposed via the DENO_SERVE_ADDRESS env var
 * (format "tcp:127.0.0.1:<port>") — set before user code runs. This was
 * verified empirically: requesting PORT=3087 still results in Next binding
 * to whatever port DENO_SERVE_ADDRESS names, not 3087. `deno desktop`'s own
 * docs confirm this is intentional for Deno.serve() ("the webview needs to
 * navigate to the same port the runtime is listening on, and the runtime is
 * the source of truth for that value") and our testing shows it applies
 * transitively to Node-compat's http server too. So PORT/BASE_URL here are
 * only the *requested* values (used verbatim under plain `deno run`, where
 * DENO_SERVE_ADDRESS is unset); getActualBaseUrl() below resolves the real
 * address after the server starts, and main.ts must use that, not the
 * PORT/BASE_URL constants, when navigating the window or calling back into
 * the API.
 */

import { copy, exists } from "jsr:@std/fs@1";
import { join } from "jsr:@std/path@1";

export const PORT = 3087;
export const BASE_URL = `http://localhost:${PORT}`;

/**
 * Resolves the actual base URL the server ended up listening on. Under
 * `deno desktop`, this reads the runtime-assigned DENO_SERVE_ADDRESS
 * (which always wins over our requested PORT); otherwise falls back to the
 * fixed BASE_URL requested above (accurate under plain `deno run`).
 */
export function getActualBaseUrl(): string {
  const addr = Deno.env.get("DENO_SERVE_ADDRESS");
  if (!addr) return BASE_URL;
  // Format: "tcp:127.0.0.1:56506"
  const match = addr.match(/^tcp:(.+):(\d+)$/);
  if (!match) return BASE_URL;
  const [, host, port] = match;
  return `http://${host}:${port}`;
}

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
    const value = line.slice(pos + 1).trim();
    vars[line.slice(0, pos).trim()] = value.replace(/^(['"])(.*)\1$/, "$2");
  }
  return vars;
}

/**
 * First run: seed writable state (data/, .env.local) into the app-data dir.
 * Next.js itself is redirected to this dir via a post-start Deno.chdir() in
 * startServer() below — see the module doc comment for why that works and
 * the symlink approach it replaces doesn't (compiled-app VFS limitation).
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

  // Next.js standalone's generated server.js calls process.chdir(__dirname)
  // itself during its synchronous top level (baked into the build output,
  // not something we control). Left alone, that resets cwd back to
  // STANDALONE_DIR before any app code runs, and — because
  // experimental.preloadEntriesOnStart is on — Next also *preloads* route
  // modules (e.g. src/app/api/scan/route.js, whose SYNC_FILE constant is
  // `path.join(process.cwd(), ...)` evaluated at module-eval time) during
  // that same startup window, before our own code regains control. So a
  // chdir *after* the import resolves is too late for those modules.
  //
  // Fix: chdir to the writable app-data dir first, then neutralize
  // process.chdir to a no-op for the remainder of the process so Next's own
  // chdir(__dirname) call becomes inert. Next's asset resolution (serving
  // .next/static, etc.) uses the `dir` it was constructed with, not
  // process.cwd(), so this doesn't break static asset serving.
  Deno.chdir(appData);
  process.chdir = () => {
    /* no-op: keep cwd pinned to the writable app-data dir (see above) */
  };

  // Next.js standalone entrypoint; runs under Deno's Node compat layer.
  await import(join(STANDALONE_DIR, "server.js"));

  console.error(`[Stow/Deno] cwd pinned to app-data dir; data/.env.local reads+writes go to ${appData}`);
  console.error(`[Stow/Deno] requested BASE_URL=${BASE_URL}; actual (post-listen) URL=${getActualBaseUrl()}`);
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
  const url = getActualBaseUrl();
  const ok = await waitForServer(url, 15000);
  console.error(ok ? `[Stow/Deno] server ready at ${url}` : "[Stow/Deno] server did not start");
}
