// Server dialects (DESIGN §18): uxopian products release fast (uxopian-ai monthly) and are still
// allowed API changes. uxc embeds knowledge of the server VERSION it talks to and branches on
// CAPABILITY FLAGS — never on raw version strings scattered through adapters.
//
// The contract:
//   - DIALECTS[product].ranges is an ORDERED list (oldest first) of { name, max, caps }: a detected
//     version matches the first range whose exclusive upper bound `max` is above it (max:null =
//     open-ended newest). Adding support for a new server release = ONE new range entry (+ the
//     capability wiring it flips). Dropping an old release = deleting its entry and raising
//     `oldestSupported` — the code paths its caps guarded can then be deleted too.
//   - Adapters call `await capabilities(ctx, product)` and read flags. One detection per product
//     per run (cached on ctx). Detection sources, in precedence order:
//       1. operator override — targets.json `fdVersion` / `aiVersion` (env UXC_FD_VERSION /
//          UXC_AI_VERSION): pins the dialect when detection is impossible or wrong;
//       2. a version endpoint — FlowerDocs Core: GET /core/actuator/info -> {version:"2026.0.0"}
//          (verified live, LEARNINGS §25); uxopian-ai exposes NO version as of 2026-07;
//       3. capability FINGERPRINT — uxopian-ai: GET /api/v1/admin/prompts answers 200-array on
//          2026-07+ builds and 500'd on 2025-era gateways (§8/§17/§25) — one cheap probe.
//   - Versions NEWER than every known range get the newest dialect + a warning (forward-compat
//     guess); versions OLDER than `oldestSupported` are a hard error (upgrade uxc or the server).
//   - `fast2` has a reserved slot: give it ranges + a detect function when support lands.
import { compareSemver, versionSupported } from './version.mjs';

export const DIALECTS = {
  flowerdocs: {
    oldestSupported: '2025.0',
    ranges: [
      // FD 2025: trailing-slash vfinstance create; echo is leaner (see canonical.mjs FD-2026 rules,
      // which are symmetric no-ops here).
      { name: 'fd-2025', max: '2026.0', caps: { vfInstanceCreatePath: '/rest/virtualFolder/', actuatorInfo: false } },
      // FD 2026: no-slash vfinstance create (404s the slash form); actuator/info version endpoint.
      { name: 'fd-2026', max: null, caps: { vfInstanceCreatePath: '/rest/virtualFolder', actuatorInfo: true } },
    ],
  },
  'uxopian-ai': {
    oldestSupported: null, // no version surface yet — fingerprint-resolved
    ranges: [
      // 2025-era gateway: admin prompt GET 500s -> reads go through the (LOSSY) user list.
      { name: 'ai-2025', max: '2026.07', caps: { adminPromptList: false, promptVersioning: false, promptWrite: 'admin-v1' } },
      // 2026-07 build: admin prompt list works and returns FULL objects (role/provider/model…).
      // promptVersioning stays false until the working-copy release lands — when it does, add a
      // new range here and wire the flag in ai-prompt (write path + post-create duplicate check).
      { name: 'ai-2026-07', max: null, caps: { adminPromptList: true, promptVersioning: false, promptWrite: 'admin-v1' } },
    ],
  },
  fast2: { oldestSupported: null, ranges: [] }, // future product slot (uxc will learn its surfaces)
};

/** First range whose exclusive `max` is above `version`; newest when beyond all bounds. */
export function rangeForVersion(product, version) {
  const p = DIALECTS[product];
  if (!p || !p.ranges.length) return null;
  if (p.oldestSupported && compareSemver(version, p.oldestSupported) < 0) {
    throw new Error(
      `${product} ${version} is older than the oldest dialect uxc supports (${p.oldestSupported}) — upgrade the server, or use an older uxc release`,
    );
  }
  for (const r of p.ranges) {
    if (r.max == null || compareSemver(version, r.max) < 0) return r;
  }
  return p.ranges[p.ranges.length - 1];
}

/** Newest (open-ended) range — the forward-compat guess for undetectable versions. */
const newestRange = (product) => DIALECTS[product].ranges[DIALECTS[product].ranges.length - 1] ?? null;

async function detectFlowerdocs(ctx) {
  const override = process.env.UXC_FD_VERSION || ctx.target?.fdVersion;
  if (override) return { version: String(override), source: 'override' };
  try {
    const r = await ctx.clients.core.raw('GET', '/actuator/info');
    const v = r.status < 400 ? r.json?.version : null;
    if (v) return { version: String(v), source: 'actuator', build: r.json?.build };
  } catch { /* actuator unreachable */ }
  return { version: null, source: 'unknown' };
}

async function detectUxopianAi(ctx) {
  const override = process.env.UXC_AI_VERSION || ctx.target?.aiVersion;
  if (override) return { version: String(override), source: 'override' };
  // fingerprint: the admin prompt list answers 200-array on 2026-07+ builds, 500 on 2025-era
  let admin = null;
  try { admin = await ctx.clients.gateway.tryGet('/api/v1/admin/prompts'); } catch { admin = null; }
  return { version: null, source: 'probe', fingerprint: { adminPromptList: Array.isArray(admin) } };
}

/**
 * Resolve the dialect for a product: { product, version, source, dialect, caps }.
 * Detected once per run per product (cached on ctx). Never throws for unknown-NEWER versions
 * (newest dialect + warn); throws for older-than-supported.
 */
export async function capabilities(ctx, product) {
  ctx._dialects ??= {};
  if (ctx._dialects[product]) return ctx._dialects[product];

  const detect = product === 'flowerdocs' ? detectFlowerdocs : product === 'uxopian-ai' ? detectUxopianAi : null;
  if (!detect) throw new Error(`dialects: unknown product "${product}" (known: ${Object.keys(DIALECTS).join(', ')})`);
  const d = await detect(ctx);

  let range = null;
  if (d.version) {
    range = rangeForVersion(product, d.version); // throws below oldestSupported
  } else if (d.fingerprint) {
    // match the fingerprint against range caps (first range whose caps agree on every probed flag)
    range = DIALECTS[product].ranges.find((r) =>
      Object.entries(d.fingerprint).every(([k, v]) => r.caps[k] === v)) ?? newestRange(product);
  } else {
    range = newestRange(product);
    if (range) {
      (ctx.out?.warn ?? console.error)(
        `${product}: server version undetectable — assuming the newest known dialect (${range.name}); pin it via targets.json ${product === 'flowerdocs' ? 'fdVersion' : 'aiVersion'} if wrong`,
      );
    }
  }

  const resolved = {
    product,
    version: d.version ?? null,
    build: d.build,
    source: d.source,
    dialect: range?.name ?? null,
    caps: { ...(range?.caps ?? {}) },
  };
  ctx._dialects[product] = resolved;
  return resolved;
}

/** Normalize the manifest's supportedVersions keys to dialect product names. */
export function supportedVersionsOf(manifest) {
  const sv = manifest?.supportedVersions ?? null;
  if (!sv) return null;
  const out = {};
  for (const [k, v] of Object.entries(sv)) {
    const product = k === 'uxopianAi' ? 'uxopian-ai' : k;
    out[product] = Array.isArray(v) ? v : [v];
  }
  return out;
}

/**
 * Server-version gate (DESIGN §18): a package that declares `supportedVersions` refuses to deploy
 * onto a server version outside its patterns — mirror of the CLIENT gate (minClientVersion).
 * Per product: undetectable server version (uxopian-ai today) -> the pattern CANNOT be enforced,
 * warn and continue. `ignore: true` (--ignore-server-version) downgrades refusals to warnings.
 * Returns [{product, version, ok, ignored?}] for reporting; throws on the first hard mismatch.
 */
export async function assertServerSupported(ctx, manifest, { ignore = false, out, action = 'deploy' } = {}) {
  const declared = supportedVersionsOf(manifest);
  if (!declared) return [];
  const results = [];
  for (const [product, patterns] of Object.entries(declared)) {
    if (!DIALECTS[product]) continue; // unknown product key: publisher-side validation flags it
    if (patterns.every((x) => String(x).trim() === '*')) {
      results.push({ product, version: null, ok: true }); // '*' matches anything — no detection needed
      continue;
    }
    const d = await capabilities(ctx, product);
    if (!d.version) {
      out?.warn?.(`${product}: supportedVersions ${JSON.stringify(patterns)} declared but the server version is undetectable — pattern not enforced (pin ${product === 'flowerdocs' ? 'fdVersion' : 'aiVersion'} on the target to enforce)`);
      results.push({ product, version: null, ok: true, unenforced: true });
      continue;
    }
    const ok = versionSupported(d.version, patterns);
    if (ok) { results.push({ product, version: d.version, ok: true }); continue; }
    const msg = `${product} ${d.version} is not in this package's supportedVersions ${JSON.stringify(patterns)}`;
    if (ignore) {
      out?.warn?.(`${msg} — OVERRIDDEN by --ignore-server-version; the ${action} may not work on this server`);
      results.push({ product, version: d.version, ok: false, ignored: true });
      continue;
    }
    const e = new Error(`${msg} — the package was not built for this server version`);
    e.explanation = `test/extend the package on ${product} ${d.version} and add the version to supportedVersions, or ${action} with --ignore-server-version (unsafe override).`;
    throw e;
  }
  return results;
}
