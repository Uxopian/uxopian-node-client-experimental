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
 * Each field is individually env-overridable (UXC_URL, UXC_SCOPE, UXC_USER, UXC_PASSWORD).
 * Returns { name, url, scope, user, password, core, gui, gateway }.
 */
export function resolveTarget(name) {
  const conf = loadTargets();
  const n = name || process.env.UXC_TARGET || conf.default;
  const base = (n && conf.targets[n]) || {};
  const t = {
    name: n || '(env)',
    url: process.env.UXC_URL || base.url,
    scope: process.env.UXC_SCOPE || base.scope,
    user: process.env.UXC_USER || base.user,
    password: process.env.UXC_PASSWORD || base.password,
  };
  if (!t.url || !t.scope || !t.user || !t.password) {
    throw new Error(
      `target "${t.name}" incomplete (need url, scope, user, password) — ` +
      `run: uxc target add <name> --url … --scope … --user … --password …`,
    );
  }
  t.url = t.url.replace(/\/+$/, '');
  t.core = `${t.url}/core`;
  t.gui = `${t.url}/gui`;
  t.gateway = `${t.url}/gui/plugins/${t.scope}/gateway/uxopian-ai`;
  return t;
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
