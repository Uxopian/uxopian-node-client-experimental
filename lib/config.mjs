// Targets (~/.uxopian/targets.json) + package discovery. Credentials never live in a package.
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { uxcDir } from './home.mjs';

/** ~/.uxopian/targets.json — resolved per call so UXC_HOME isolates it on every platform (#71). */
export const targetsPath = () => uxcDir('targets.json');

export function loadTargets() {
  if (!existsSync(targetsPath())) return { default: null, targets: {} };
  return JSON.parse(readFileSync(targetsPath(), 'utf8'));
}

export function saveTargets(conf) {
  mkdirSync(dirname(targetsPath()), { recursive: true });
  writeFileSync(targetsPath(), JSON.stringify(conf, null, 2) + '\n');
  chmodSync(targetsPath(), 0o600);
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
 *   - `f2`   — optional; the fast2 BROKER base (e.g. http://localhost:1789), with its own
 *              `f2User`/`f2Password` (fast2 has a SEPARATE user store — FAST2-LEARNINGS §F3).
 *              NEVER derived from the Core host. Env: UXC_F2_URL / UXC_F2_USER / UXC_F2_PASSWORD.
 *
 * Legacy: a single `url` host (env UXC_URL) still works — `core`, `gui`, and the gateway are
 * derived from `url` + `scope` exactly as before. Explicit `core`/`ai`/`gui` win over derivation.
 *
 * `scope` is required for a FlowerDocs target (it authenticates: POST /core/rest/authentication
 * {user,password,scope}).
 *
 * Fast2-only target (FAST-5875): `f2` set and NO FlowerDocs/AI field at all (no url/core/ai/gui/
 * scope/user/password) -> valid, with `core`/`gui`/`gateway`/`ai` = null and `fd: false`. Every
 * FlowerDocs / Uxopian AI client then refuses before any network call (lib/http.mjs noSurface).
 * A target with SOME FlowerDocs field still needs all of them (a half-configured FD target is an
 * error, never silently Fast2-only).
 * Returns { name, url(host), scope, user, password, core, gui, gateway, ai, f2, f2User, f2Password, fd }.
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
  const f2Version = env.UXC_F2_VERSION || base.f2Version || null;

  // explicit bases (preferred) + legacy host
  const coreUrl = trim(env.UXC_CORE_URL || base.core);
  const aiUrl = trim(env.UXC_AI_URL || base.ai || base.gateway);   // accept `gateway` as an alias
  const guiUrl = trim(env.UXC_GUI_URL || base.gui);
  const hostUrl = trim(env.UXC_URL || base.url)
    || (coreUrl ? coreUrl.replace(/\/core$/i, '') : null);          // derive the host from `…/core`

  // fast2 broker: an INDEPENDENT surface with its OWN user store (FAST2-LEARNINGS §F3) — never
  // derived from the Core host (usually a different machine) and never sharing FD credentials.
  // Optional: a target without `f2` simply cannot push f2.* resources.
  const f2 = trim(env.UXC_F2_URL || base.f2);
  const f2User = env.UXC_F2_USER || base.f2User || null;
  const f2Password = env.UXC_F2_PASSWORD || base.f2Password || null;

  const core = coreUrl || (hostUrl ? `${hostUrl}/core` : null);
  const gui = guiUrl || (hostUrl ? `${hostUrl}/gui` : null);
  const gateway = aiUrl
    || (hostUrl && scope ? `${hostUrl}/gui/plugins/${scope}/gateway/uxopian-ai` : null);

  // Fast2-only: a broker and nothing FlowerDocs-shaped (env or stored)
  const fdFields = [coreUrl, aiUrl, guiUrl, hostUrl, scope, user, password];
  if (f2 && fdFields.every((v) => !v)) {
    return {
      name: n || '(env)', url: null, scope: null, user: null, password: null,
      core: null, gui: null, gateway: null, ai: null, fd: false,
      f2, f2User, f2Password, fdVersion, aiVersion, f2Version,
      allowTests: !!(env.UXC_ALLOW_TESTS || base.allowTests),
    };
  }

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
      `  (or the legacy shorthand: --url https://host --scope <scope> …, which derives /core, /gui and the gateway)\n` +
      `  (a Fast2-only target needs only: --f2 <broker url> --f2-user <email> --f2-password <p>)`,
    );
  }

  // allowTests: the target's standing opt-in for `uxc test` (functional tests create/delete
  // real objects). Env override for CI: UXC_ALLOW_TESTS=1.
  const allowTests = !!(env.UXC_ALLOW_TESTS || base.allowTests);

  return {
    name: n || '(env)', url: hostUrl, scope, user, password, core, gui, gateway, ai: gateway,
    f2, f2User, f2Password, fdVersion, aiVersion, f2Version, allowTests, fd: true,
  };
}

/**
 * The target NAME only, resolved leniently (no credential validation, no throw).
 * The lock (lib/lock.mjs) and the package target pin (lib/agent.mjs) both need to know WHICH
 * instance a command will talk to before the command runs — i.e. before resolveTarget() would be
 * entitled to reject an incomplete target.
 */
export function resolveTargetName(name) {
  if (name && typeof name === 'string') return name;
  if (process.env.UXC_TARGET) return process.env.UXC_TARGET;
  try { return loadTargets().default ?? null; } catch { return null; }
}

/** @deprecated resolved at IMPORT time, so it ignores a UXC_HOME set later — call targetsPath() (#76). */
export const TARGETS_FILE = targetsPath();

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
