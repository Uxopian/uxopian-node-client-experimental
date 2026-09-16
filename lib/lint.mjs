// Offline lints: everything provable from the package alone, before a byte reaches the server
// (BACKLOG-AGENTIC #7/#17/#20). No network, no target — so `verify` runs them and `push` uses
// them as a pre-flight, which is the point: both halves of each check live in the package, and
// finding out from a 500 mid-push is finding out too late.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { KINDS } from './kinds/index.mjs';
import { stripFullLineComments } from './include.mjs';
import { isBinary, tokenBoundaryRe } from './refs.mjs';

const safeJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const safeRead = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };

// ---------------------------------------------------------------------------
// #20 — constrained tag values: a CHOICELIST tag value outside allowedValues
// ---------------------------------------------------------------------------
// The server answers `500 F00020: the value X is not an allowed choice for tag T` mid-push, after
// earlier resources are already up. Both halves (the tagclass and the value) are in the package,
// so this is knowable offline. Only CHOICELIST is constrained — FREELIST accepts new values by
// design (LEARNINGS, 2026-09-05) — and only tagclasses the package OWNS can be checked: a
// server-side tagclass we do not manage has no local allowedValues to compare against.

/** id -> {type, values:Set<string>, constrained} for every fd.tagclass in the registry. */
export function tagclassIndex(pkg) {
  const idx = new Map();
  for (const e of pkg.entries('fd.tagclass')) {
    const obj = safeJson(join(pkg.dir, e.path));
    if (!obj) continue;
    const values = new Set(
      (obj.allowedValues ?? []).map((v) => (typeof v === 'string' ? v : v?.symbolicName ?? v?.value)).filter(Boolean),
    );
    idx.set(e.id, { type: obj.type ?? null, values, constrained: obj.type === 'CHOICELIST' && values.size > 0 });
  }
  return idx;
}

const tagPairs = (tags) => (Array.isArray(tags) ? tags : []).flatMap((t) => {
  const vals = Array.isArray(t?.value) ? t.value : t?.value == null ? [] : [t.value];
  return vals.map((v) => ({ name: t?.name, value: String(v) }));
});

/** -> [{where, tag, value, allowed:[…], message}] — one per offending value. */
export function lintTagValues(pkg) {
  const idx = tagclassIndex(pkg);
  if (!idx.size) return [];
  const problems = [];
  const check = (where, tags) => {
    for (const { name, value } of tagPairs(tags)) {
      const tc = idx.get(name);
      if (!tc?.constrained || tc.values.has(value)) continue;
      const allowed = [...tc.values].sort();
      problems.push({
        where, tag: name, value, allowed,
        message: `${where}: tag ${name}="${value}" is not an allowed choice — ${name} (CHOICELIST) admits ${allowed.map((v) => `"${v}"`).join(', ')}`
          + ` · add the value to fd/tagclasses/${name}.json allowedValues, or fix the value`,
      });
    }
  };

  for (const entry of pkg.entries()) {
    if (entry.retired) continue;
    const adapter = KINDS[entry.kind];
    if (!adapter?.readLocal) continue;
    let local = null;
    try { local = adapter.readLocal(pkg, entry); } catch { continue; } // unreadable: validate()'s error
    if (!local) continue;
    if (entry.kind === 'fd.dataset') {
      for (const row of local.rows?.values() ?? []) {
        if (row?._deleted) continue;
        check(`${entry.id}/${row.id}`, row.tags);
      }
    } else if (Array.isArray(local.obj?.tags)) {
      check(`${entry.kind}/${entry.id}`, local.obj.tags);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// #7 — prompt variables with no caller providing them
// ---------------------------------------------------------------------------
// A prompt gains `[[${openObligations}]]`, the deployed handlers never send it, and the gateway
// HANGS to timeout instead of erroring — the most expensive failure shape in the backlog because
// it produces no error code for `uxc explain` to work from.
//
// This is a WARNING and must never become a blocker: a prompt can legitimately be called from
// outside the package (another client, a script, Uxopian AI with no FlowerDocs at all), so the
// absence of a caller proves nothing. Only a caller found WITH a statically-readable payload that
// omits a variable is real evidence.

const HELPERLESS_VAR_RE = /\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g; // bare ${x}: dots/parens = a server-side helper call

/** Payload variables of a prompt content (helper calls like ${svc.fn(x)} excluded by shape). */
export function promptVariables(content) {
  const out = new Set();
  for (const m of String(content ?? '').matchAll(HELPERLESS_VAR_RE)) out.add(m[1]);
  return out;
}

/** Top-level keys of the object literal starting at text[open] === '{'. null if unparseable. */
function objectKeys(text, open) {
  if (text[open] !== '{') return null;
  const keys = [];
  let depth = 0;
  let i = open;
  let quote = null;
  let pendingKey = '';
  for (; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) { quote = null; continue; }
      if (depth === 1) pendingKey += c;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { if (depth === 1) pendingKey = ''; quote = c; continue; }
    if (c === '{' || c === '[' || c === '(') { depth++; continue; }
    if (c === '}' || c === ']' || c === ')') { depth--; if (depth === 0) return keys; continue; }
    if (depth === 1) {
      if (c === ':') { const k = pendingKey.trim(); if (/^[A-Za-z_$][\w$]*$/.test(k)) keys.push(k); pendingKey = ''; }
      else if (c === ',') pendingKey = '';
      else pendingKey += c;
    }
  }
  return null; // unbalanced — refuse to guess
}

/** Text of the argument list of the call enclosing position `at` — '(' … matching ')'. null if
 *  the shape is not a plain call (the caller then falls back to a bounded lookahead). */
function enclosingCallArgs(text, at) {
  let depth = 0;
  let open = -1;
  for (let i = at; i >= 0 && at - i < 400; i--) {
    const c = text[i];
    if (c === ')') depth++;
    else if (c === '(') { if (depth === 0) { open = i; break; } depth--; }
    else if (c === ';' || c === '\n' && depth === 0 && text[i - 1] === ';') break;
  }
  if (open === -1) return null;
  let d = 0;
  let quote = null;
  for (let i = open; i < text.length && i - open < 20_000; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '(') d++;
    else if (c === ')') { d--; if (d === 0) return text.slice(open + 1, i); }
  }
  return null;
}

const LOOKAHEAD = 240; // an inline payload follows its prompt id closely; further away it is another statement

/**
 * Call sites of `promptId` in `text`: [{line, keys, argText}].
 *   keys    — top-level keys of the payload object literal, or null when it is not a literal;
 *   argText — the whole argument list of the call, because a key is not always an object key:
 *             `fireGathered('ctX', {a:1}, 'libraryJson', fn)` provides libraryJson as an ARGUMENT.
 *             Reporting those as missing is how a lint earns its way onto the ignore list.
 */
export function promptCallSites(text, promptId) {
  const sites = [];
  const idRe = new RegExp(`(['"\`])${promptId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1`, 'g');
  for (const m of String(text).matchAll(idRe)) {
    const from = m.index + m[0].length;
    const window = text.slice(from, from + LOOKAHEAD);
    const stop = window.search(/[;}]\s*\n/);
    const scan = stop === -1 ? window : window.slice(0, stop);
    const brace = scan.indexOf('{');
    const keys = brace === -1 ? null : objectKeys(text, from + brace);
    sites.push({
      line: text.slice(0, m.index).split('\n').length,
      keys,
      argText: enclosingCallArgs(text, m.index) ?? scan,
    });
  }
  return sites;
}

/** Package text files a prompt call can live in: handler/script sources and embedded tests. */
function callerFiles(pkg) {
  const out = [];
  const walk = (abs, rel) => {
    if (!existsSync(abs)) return;
    for (const name of readdirSync(abs).sort()) {
      if (name === '.uxc' || name === '.git') continue;
      const a = join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(a).isDirectory()) walk(a, r);
      else if (/\.(js|mjs|cjs|json)$/.test(name)) {
        let buf; try { buf = readFileSync(a); } catch { continue; }
        if (isBinary(buf)) continue;
        out.push({ path: r, text: buf.toString('utf8') });
      }
    }
  };
  walk(join(pkg.dir, 'fd'), 'fd');
  walk(join(pkg.dir, 'tests'), 'tests');
  return out;
}

/**
 * -> [{prompt, kind:'unprovided'|'no-caller', variables, callers:[{path,line}], message}]
 * 'unprovided' = a caller with a readable payload omits the variable (real evidence).
 * 'no-caller'  = nothing in this package calls the prompt (informational only).
 */
const agentObjectives = (pkg) => new Set(pkg.entries('ai.agent').filter((e) => !e.retired)
  .map((e) => { try { return KINDS['ai.agent'].readLocal(pkg, e)?.obj?.objective; } catch { return null; } })
  .filter(Boolean));

export function lintPromptVariables(pkg) {
  const prompts = pkg.entries('ai.prompt').filter((e) => !e.retired);
  if (!prompts.length) return [];
  const files = callerFiles(pkg);
  const findings = [];
  let objectives = null; // lazily: only prompts without a caller need it

  for (const entry of prompts) {
    const contentPath = join(pkg.dir, entry.path.replace(/\.json$/, '.content.md'));
    const content = safeRead(contentPath);
    if (content == null) continue;
    const vars = promptVariables(content);
    if (!vars.size) continue;

    const callers = [];
    let anyLiteral = false;
    const provided = new Set();
    let mentioned = '';
    for (const f of files) {
      if (!f.text.includes(entry.id)) continue;
      for (const site of promptCallSites(f.text, entry.id)) {
        callers.push({ path: f.path, line: site.line, keys: site.keys });
        mentioned += `\n${site.argText ?? ''}`;
        if (site.keys) { anyLiteral = true; for (const k of site.keys) provided.add(k); }
      }
    }

    if (!callers.length) {
      // the objective of a package agent is called by the plan engine — lintAgentic owns that check
      objectives ??= agentObjectives(pkg);
      if (objectives.has(entry.id)) continue;
      findings.push({
        prompt: entry.id, kind: 'no-caller', variables: [...vars], callers: [],
        message: `ai.prompt/${entry.id}: variables ${[...vars].map((v) => `\${${v}}`).join(', ')} — no caller in this package`
          + ' (fine if it is called from outside; otherwise the gateway will HANG on the unsubstituted variable)',
      });
      continue;
    }
    if (!anyLiteral) continue; // callers exist but build their payload dynamically — nothing provable
    // A variable counts as provided when it is an object key OR simply named anywhere in the call
    // (a key gathered asynchronously, a spread, a constant). Only a name the caller never utters
    // is evidence — anything weaker turns this lint into noise and gets it ignored.
    const missing = [...vars].filter((v) => !provided.has(v) && !tokenBoundaryRe(v, '').test(mentioned));
    if (missing.length) {
      findings.push({
        prompt: entry.id, kind: 'unprovided', variables: missing,
        callers: callers.filter((c) => c.keys).map(({ path, line }) => ({ path, line })),
        message: `ai.prompt/${entry.id}: variable(s) ${missing.map((v) => `\${${v}}`).join(', ')} provided by no caller`
          + ` — callers: ${callers.filter((c) => c.keys).map((c) => `${c.path}:${c.line}`).join(', ')}`
          + ' · an unsubstituted variable makes the gateway hang until timeout, with no error code',
      });
    }
  }
  return findings;
}

/**
 * Push ordering hint (#7, second half): kinds are ordered by PUSH_ORDER, but WITHIN a plan the
 * handler that provides a prompt's variables should land before the prompt that consumes them, so
 * the first call after the deploy is already complete. -> [{prompt, before:[handlerIds], why}]
 */
export function promptProviderOrder(pkg, entries) {
  const promptIds = new Set(entries.filter((e) => e.kind === 'ai.prompt').map((e) => e.id));
  if (!promptIds.size) return [];
  const handlers = entries.filter((e) => e.kind === 'fd.handler');
  if (!handlers.length) return [];
  const hints = [];
  for (const p of promptIds) {
    const before = [];
    for (const h of handlers) {
      const dir = join(pkg.dir, h.path);
      const files = existsSync(dir) && statSync(dir).isDirectory() ? readdirSync(dir) : [];
      const text = files.map((f) => safeRead(join(dir, f)) ?? '').join('\n');
      if (text.includes(p)) before.push(h.id);
    }
    if (before.length) {
      hints.push({
        prompt: p, before,
        why: `handler(s) ${before.join(', ')} call ${p} — deploying the caller first means the prompt's first call already carries every variable`,
      });
    }
  }
  return hints;
}

// ---------------------------------------------------------------------------
// #17 — composed size budget
// ---------------------------------------------------------------------------
// nginx refuses a body over ~1 MB on /core/rest/files/tmp and the push answers a bare
// `413 Request Entity Too Large` (LEARNINGS §30/§33). The composed size is knowable before the
// request, and so is what `// @include … strip` would still save.

export const DEFAULT_SIZE_WARN_BYTES = 900_000;
export const HARD_LIMIT_BYTES = 1_000_000;

/** The push-body budget of content-bearing entries -> [{kind,id,file,bytes,strippedBytes,saved}]. */
export function resourceSizes(pkg, entries = pkg.entries()) {
  const rows = [];
  for (const entry of entries) {
    if (entry.retired) continue;
    const adapter = KINDS[entry.kind];
    if (!adapter?.readLocal) continue;
    let local = null;
    try { local = adapter.readLocal(pkg, entry); } catch { continue; }
    for (const [file, bytes] of Object.entries(local?.contents ?? {})) {
      const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes));
      const stripped = /\.(js|mjs)$/.test(file) ? Buffer.byteLength(stripFullLineComments(buf.toString('utf8'))) : buf.length;
      rows.push({
        kind: entry.kind, id: entry.id, file, bytes: buf.length,
        strippedBytes: stripped, saved: buf.length - stripped,
      });
    }
  }
  return rows.sort((a, b) => b.bytes - a.bytes);
}

/** Rows at or over the warn threshold, with the message push/size print. */
export function sizeWarnings(rows, warnAt = DEFAULT_SIZE_WARN_BYTES) {
  return rows.filter((r) => r.bytes >= warnAt).map((r) => ({
    ...r,
    over: r.bytes >= HARD_LIMIT_BYTES,
    message: `${r.kind}/${r.id} composes to ${kb(r.bytes)} (${r.file})`
      + (r.bytes >= HARD_LIMIT_BYTES
        ? ` — OVER the ~${kb(HARD_LIMIT_BYTES)} server body limit: the push will answer 413`
        : ` — within ${kb(HARD_LIMIT_BYTES - r.bytes)} of the ~${kb(HARD_LIMIT_BYTES)} server body limit`)
      + (r.saved > 0 ? ` · \`// @include <file> strip\` on its parts would save ${kb(r.saved)}` : ''),
  }));
}

export const kb = (n) => `${(n / 1000).toFixed(1)} kB`;

// ---------------------------------------------------------------------------
// #9 — include order
// ---------------------------------------------------------------------------
// `_shared` libraries have an implicit load order (a library that calls into another must be
// included after it). Get it wrong and nothing complains until run time, in a handler, on the
// server. The order is declared ONCE per package and every composed source is checked against it:
//
//   "includeOrder": ["po-lib.js", "po-calendar.js", "po-time.js", "po-rules.js", …]
//
// A source need not use every library — it must only not CONTRADICT the order, so the check is
// "the directives are a subsequence of the declaration", not equality.

const INCLUDE_LINE_RE = /^[ \t]*\/\/[ \t]*@include[ \t]+(\S+)/;

/** Included paths, in source order, for every composed file: [{path, includes:[rel…]}]. */
export function includeOrders(pkg) {
  const out = [];
  const walk = (abs, rel) => {
    if (!existsSync(abs)) return;
    for (const name of readdirSync(abs).sort()) {
      const a = join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(a).isDirectory()) walk(a, r);
      else if (/\.(js|mjs)$/.test(name)) {
        const text = safeRead(a);
        if (text == null) continue;
        const includes = text.split('\n').map((l) => INCLUDE_LINE_RE.exec(l)?.[1]).filter(Boolean);
        if (includes.length) out.push({ path: r, includes });
      }
    }
  };
  walk(join(pkg.dir, 'fd', 'handlers'), 'fd/handlers');
  walk(join(pkg.dir, 'fd', 'scripts'), 'fd/scripts');
  return out;
}

/** Declared order (manifest.includeOrder, or agent.includeOrder), basenames, or [] when absent. */
export function declaredIncludeOrder(pkg) {
  const raw = pkg.manifest?.includeOrder ?? pkg.manifest?.agent?.includeOrder ?? [];
  return Array.isArray(raw) ? raw.map((x) => String(x).replace(/.*\//, '')) : [];
}

/** -> [{path, message}] where a source's directives contradict the declared order. */
export function lintIncludeOrder(pkg) {
  const declared = declaredIncludeOrder(pkg);
  if (!declared.length) return [];
  const rank = new Map(declared.map((n, i) => [n, i]));
  const problems = [];
  for (const { path, includes } of includeOrders(pkg)) {
    const known = includes.map((p) => p.replace(/.*\//, '')).filter((b) => rank.has(b));
    for (let i = 1; i < known.length; i++) {
      if (rank.get(known[i]) < rank.get(known[i - 1])) {
        problems.push({
          path,
          message: `${path}: @include ${known[i]} comes after ${known[i - 1]}, but the package's includeOrder puts it before`
            + ` — a library included before the one it depends on fails only at run time, in the handler`
            + ` · declared order: ${declared.join(' -> ')}`,
        });
        break; // one report per file is enough to send someone to the right place
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Agentic Plan engine (uxopian-ai 2026.0.0-ft5): references + node variables
// ---------------------------------------------------------------------------
// The gateway stores agents and plans WITHOUT checking what they name (AI learnings §A13): an
// agent whose objective prompt does not exist, a plan node naming a missing agent, or an agent
// deleted under a plan all save fine and only fail when the plan RUNS. And a plan is refused at
// run time — 400 "Plan is not executable" — when a node's prompt reads a variable no upstream node
// provides (§A14). Both halves are in the package, so both are knowable offline.
// WARNINGS, never blockers: a reference may legitimately point at an object already on the server.

const localObj = (pkg, kind, id) => {
  const entry = pkg.entry(kind, id);
  if (!entry || entry.retired) return null;
  try { return KINDS[kind].readLocal(pkg, entry)?.obj ?? null; } catch { return null; }
};

/**
 * -> [{where, kind:'dangling'|'unprovided', message}]
 * dangling   = an id this package does not define (must already exist on the target)
 * unprovided = a node's prompt variable no dependency, persisted output or plan input provides
 */
export function lintAgentic(pkg) {
  const findings = [];
  const dangling = (where, what, id, kind) => findings.push({
    where, kind: 'dangling',
    message: `${where}: ${what} "${id}" is not a ${kind} of this package — it must already exist on the target (the gateway does not check; the run fails otherwise)`,
  });

  for (const e of pkg.entries('ai.agent').filter((x) => !x.retired)) {
    const a = localObj(pkg, 'ai.agent', e.id);
    if (!a) continue;
    const where = `ai.agent/${e.id}`;
    if (a.objective && !pkg.entry('ai.prompt', a.objective)) dangling(where, 'objective', a.objective, 'ai.prompt');
    for (const p of a.permissions?.allowedSubPlans ?? []) if (!pkg.entry('ai.plan', p)) dangling(where, 'allowedSubPlans', p, 'ai.plan');
  }

  for (const e of pkg.entries('ai.application').filter((x) => !x.retired)) {
    const app = localObj(pkg, 'ai.application', e.id);
    if (!app) continue;
    const where = `ai.application/${e.id}`;
    if (app.prompt && !pkg.entry('ai.prompt', app.prompt)) dangling(where, 'prompt', app.prompt, 'ai.prompt');
    for (const p of app.permissions?.allowedSubPlans ?? []) if (!pkg.entry('ai.plan', p)) dangling(where, 'allowedSubPlans', p, 'ai.plan');
  }

  for (const e of pkg.entries('ai.plan').filter((x) => !x.retired)) {
    const plan = localObj(pkg, 'ai.plan', e.id);
    if (!plan || !Array.isArray(plan.nodes)) continue;
    const where = `ai.plan/${e.id}`;
    const byId = new Map(plan.nodes.filter((n) => n?.id).map((n) => [n.id, n]));
    const inputs = (plan.toolInputParameters ?? []).map((p) => p?.name).filter(Boolean);
    const persisted = plan.nodes.filter((n) => n?.persistOutput === true && n.outputKey).map((n) => n.outputKey);

    for (const n of plan.nodes) {
      if (!n || typeof n !== 'object') continue;
      if (n.type === 'SUBPLAN' && n.subPlanId && !pkg.entry('ai.plan', n.subPlanId)) dangling(`${where} node "${n.id}"`, 'subPlanId', n.subPlanId, 'ai.plan');
      if (n.type !== 'AGENT' || !n.agentConfId) continue;
      if (!pkg.entry('ai.agent', n.agentConfId)) { dangling(`${where} node "${n.id}"`, 'agentConfId', n.agentConfId, 'ai.agent'); continue; }

      const agent = localObj(pkg, 'ai.agent', n.agentConfId);
      const prompt = agent?.objective ? localObj(pkg, 'ai.prompt', agent.objective) : null;
      if (!prompt) continue; // objective outside the package: its variables are not knowable here
      const provided = new Set([
        ...inputs, ...persisted,
        ...(n.dependencies ?? []).map((d) => byId.get(d)?.outputKey).filter(Boolean),
        ...(n.listKey ? ['item'] : []),
      ]);
      const missing = [...promptVariables(prompt.content)].filter((v) => !provided.has(v));
      if (missing.length) {
        findings.push({
          where: `${where} node "${n.id}"`, kind: 'unprovided',
          message: `${where}: node "${n.id}" runs ${n.agentConfId} whose prompt ${agent.objective} reads ${missing.map((v) => `\${${v}}`).join(', ')}`
            + ' — provided by no dependency outputKey, persistOutput node or toolInputParameters: the gateway refuses to run the plan (400 "Plan is not executable")',
        });
      }
    }
  }
  return findings;
}
