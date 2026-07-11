// Targets (~/.uxopian/targets.json) + package discovery. Credentials never live in a package.
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';

const TARGETS_PATH = join(homedir(), '.uxopian', 'targets.json');

export function loadTargets() {
  if (!existsSync(TARGETS_PATH)) return { default: null, targets: {} };
  return JSON.parse(readFileSync(TARGETS_PATH, 'utf8'));
}

export function saveTargets(conf) {
  mkdirSync(dirname(TARGETS_PATH), { recursive: true });
  writeFileSync(TARGETS_PATH, JSON.stringify(conf, null, 2) + '\n');
  chmodSync(TARGETS_PATH, 0o600);
}

/**
 * Resolve the target to talk to. Precedence: --target flag > UXC_TARGET > targets.json default.
 *
 * Two base URLs are configured explicitly (recommended):
 *   - `core` — the FlowerDocs Core REST base, up to and INCLUDING `/core`
 *              (e.g. https://host/core). Env: UXC_CORE_URL.
 *   - `ai`   — the Uxopian AI gateway base, up to and INCLUDING `uxopian-ai`
 *              (e.g. https://host/gui/plugins/IRIS/gateway/uxopian-ai). Env: UXC_AI_URL.
 *   - `gui`  — optional; the GUI base for cache-clear/script content (default: derived from the
 *              host, i.e. `<host>/gui`). Env: UXC_GUI_URL.
 *
 * Legacy: a single `url` host (env UXC_URL) still works — `core`, `gui`, and the gateway are
 * derived from `url` + `scope` exactly as before. Explicit `core`/`ai`/`gui` win over derivation.
 *
 * `scope` is always required (it authenticates: POST /core/rest/authentication {user,password,scope}).
 * Returns { name, url(host), scope, user, password, core, gui, gateway, ai }.
 */
export function resolveTarget(name) {
  const conf = loadTargets();
  const n = name || process.env.UXC_TARGET || conf.default;
  const base = (n && conf.targets[n]) || {};
  const trim = (u) => (u ? String(u).replace(/\/+$/, '') : u);
  const env = process.env;

  const scope = env.UXC_SCOPE || base.scope;
  const user = env.UXC_USER || base.user;
  const password = env.UXC_PASSWORD || base.password;
  // optional dialect pins (lib/dialects.mjs): override server-version detection per target
  const fdVersion = env.UXC_FD_VERSION || base.fdVersion || null;
  const aiVersion = env.UXC_AI_VERSION || base.aiVersion || null;

  // explicit bases (preferred) + legacy host
  const coreUrl = trim(env.UXC_CORE_URL || base.core);
  const aiUrl = trim(env.UXC_AI_URL || base.ai || base.gateway);   // accept `gateway` as an alias
  const guiUrl = trim(env.UXC_GUI_URL || base.gui);
  const hostUrl = trim(env.UXC_URL || base.url)
    || (coreUrl ? coreUrl.replace(/\/core$/i, '') : null);          // derive the host from `…/core`

  const core = coreUrl || (hostUrl ? `${hostUrl}/core` : null);
  const gui = guiUrl || (hostUrl ? `${hostUrl}/gui` : null);
  const gateway = aiUrl
    || (hostUrl && scope ? `${hostUrl}/gui/plugins/${scope}/gateway/uxopian-ai` : null);

  const missing = [];
  if (!core) missing.push('core URL');
  if (!gateway) missing.push('uxopian-ai URL');
  if (!scope) missing.push('scope');
  if (!user) missing.push('user');
  if (!password) missing.push('password');
  if (missing.length) {
    throw new Error(
      `target "${n || '(env)'}" incomplete (missing: ${missing.join(', ')}) — run:\n` +
      `  uxc target add <name> --core https://host/core ` +
      `--ai https://host/gui/plugins/<scope>/gateway/uxopian-ai --scope <scope> --user <u> --password <p>\n` +
      `  (or the legacy shorthand: --url https://host --scope <scope> …, which derives /core, /gui and the gateway)`,
    );
  }

  // allowTests: the target's standing opt-in for `uxc test` (functional tests create/delete
  // real objects). Env override for CI: UXC_ALLOW_TESTS=1.
  const allowTests = !!(env.UXC_ALLOW_TESTS || base.allowTests);

  return { name: n || '(env)', url: hostUrl, scope, user, password, core, gui, gateway, ai: gateway, fdVersion, aiVersion, allowTests };
}

export const TARGETS_FILE = TARGETS_PATH;

/** Walk upward from `start` to find the directory holding uxopian-project.json. */
export function findPackageDir(start = process.cwd()) {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'uxopian-project.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
