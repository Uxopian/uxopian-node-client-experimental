// Marketplace connection config (~/.uxopian/marketplace.json, chmod 600) — the Pulse Addons
// Marketplace endpoints + a per-maintainer API key. Kept OUTSIDE any package (like targets.json):
// a key is a credential, never committed, never exported in a .uxpkg.
//
// The deployment exposes THREE endpoints whose URL IS the API root (routes append directly): a
// `…-publish` root for writes + whoami, a `…-browse` root for reads, and a `…-download` root for
// the artifact 302. `url` is the publish root; `browseUrl`/`downloadUrl` are auto-derived by
// swapping the `-publish` suffix for `-browse` / `-download` when omitted. Ask a marketplace
// admin for your endpoint URL.
//
// Shape:
//   { "url": "<MARKETPLACE_PUBLISH_URL>",
//     "browseUrl": "…/marketplace-browse",      // optional; derived from url
//     "downloadUrl": "…/marketplace-download",   // optional; derived from url
//     "token": "uxmk_…",
//     "maintainer": { "name": "Your Name", "email": "you@example.com" } }
//
// Env overrides: UXC_MARKETPLACE_URL, UXC_MARKETPLACE_BROWSE_URL, UXC_MARKETPLACE_DOWNLOAD_URL,
// UXC_MARKETPLACE_TOKEN.
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { uxcDir } from './home.mjs';

/** ~/.uxopian/marketplace.json — resolved per call (UXC_HOME, #71). */
const marketplacePath = () => uxcDir('marketplace.json');
export const MARKETPLACE_FILE = marketplacePath();

export function loadMarketplace() {
  if (!existsSync(marketplacePath())) return {};
  try { return JSON.parse(readFileSync(marketplacePath(), 'utf8')); }
  catch { return {}; }
}

export function saveMarketplace(conf) {
  mkdirSync(dirname(marketplacePath()), { recursive: true });
  writeFileSync(marketplacePath(), JSON.stringify(conf, null, 2) + '\n');
  chmodSync(marketplacePath(), 0o600);
}

/**
 * Resolve the marketplace endpoint + credential. Env wins over the file.
 * `requireToken` (default true) throws a helpful message when no key is configured; pass false
 * for read-only browse where an anonymous/session-less call may still be allowed by the server.
 * Returns { url, token, maintainer }.
 */
/** Derive a sibling function root from the publish root by swapping the `-publish` suffix. */
export function deriveSiblingUrl(publishUrl, sibling) {
  if (!publishUrl) return null;
  return /marketplace-publish/.test(publishUrl)
    ? publishUrl.replace('marketplace-publish', `marketplace-${sibling}`)
    : publishUrl; // single-root deployments: all routes share one URL
}

export function resolveMarketplace({ requireToken = true } = {}) {
  const conf = loadMarketplace();
  const clean = (s) => (s || '').replace(/\/+$/, '');
  const url = clean(process.env.UXC_MARKETPLACE_URL || conf.url);
  const browseUrl = clean(process.env.UXC_MARKETPLACE_BROWSE_URL || conf.browseUrl || deriveSiblingUrl(url, 'browse'));
  const downloadUrl = clean(process.env.UXC_MARKETPLACE_DOWNLOAD_URL || conf.downloadUrl || deriveSiblingUrl(url, 'download'));
  const token = process.env.UXC_MARKETPLACE_TOKEN || conf.token || null;
  if (!url) {
    throw new Error(
      'no marketplace endpoint configured — run: ' +
      'uxc mp login --url <MARKETPLACE_PUBLISH_URL> --token uxmk_… [--name "…" --email …]',
    );
  }
  if (requireToken && !token) {
    throw new Error(
      'no marketplace API key configured — run: ' +
      'uxc mp login --url ' + url + ' --token uxmk_… (per-maintainer key from Pulse)',
    );
  }
  return { url, browseUrl, downloadUrl, token, maintainer: conf.maintainer ?? null };
}
