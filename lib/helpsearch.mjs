// uxc help --search — offline "what I want to do" -> commands + knowledge-base references (#94).
// One BM25 index, built lazily at search time (a few ms, no cache file), over:
//   - every command module's name/summary/usage, plus its line in the static help map
//   - the `explain` knowledge base (signature + explanation)
//   - claude/skills/uxopian-client/references/kinds.md sections (one per kind)
//   - each `##`/`###` heading + its first lines in the four knowledge files under docs/
// Zero dependencies and deterministic: ties break on the corpus order. Paths resolve against the
// uxc install (the docs ship with the repo); a missing file is skipped without a word.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { KB_ENTRIES } from './explain.mjs';
import { TWO_WORD } from './cli-meta.mjs';

export const UXC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The knowledge files, in ranking-tie order. `label` is what a reference prints. */
export const KNOWLEDGE_FILES = [
  { label: 'FLOWERDOCS-LEARNINGS', path: 'docs/FLOWERDOCS-LEARNINGS.md' },
  { label: 'UXOPIAN-AI-LEARNINGS', path: 'docs/UXOPIAN-AI-LEARNINGS.md' },
  { label: 'FAST2-LEARNINGS', path: 'docs/FAST2-LEARNINGS.md' },
  { label: 'DIAGNOSTICS', path: 'docs/DIAGNOSTICS.md' },
];
export const KINDS_FILE = 'claude/skills/uxopian-client/references/kinds.md';

/** Lines of a section body indexed after its heading — enough to catch the gist, not the essay. */
const BODY_LINES = 12;

const STOP = new Set(('a an the and or of to in on for with by from at as is are be it its this that '
  + 'these those i my me we our you your how do does can what which when where why not no into '
  + 'there their than then so if via vs uxc').split(' '));

// Query-side expansion only: a synonym scores at SYN_WEIGHT, so "delete" still prefers a text that
// literally says delete, yet reaches `rm`. Groups are stems (see stem()).
const SYNONYMS = [
  ['updat', 'push', 'chang', 'edit', 'modify', 'modifi', 'deploy'],
  ['delet', 'rm', 'remov', 'destroy', 'drop'],
  ['list', 'ls', 'brows', 'enumerat'],
  ['get', 'read', 'fetch', 'show', 'inspect'],
  ['creat', 'add', 'new', 'scaffold'],
  ['doc', 'document'],
  ['error', 'fail', 'failur', 'refus'],
  ['rate', 'throttl', '429'],
  ['install', 'import', 'deploy'],
  ['download', 'pull'],
  ['publish', 'mp', 'marketplac'],
  ['tag', 'tagclass'],
  ['task', 'taskclass'],
  ['class', 'documentclass'],
  ['folder', 'vf', 'vfinstanc', 'vfclass'],
  ['handler', 'operationhandler'],
  ['cache', 'cach'],
  ['prompt', 'ai'],
];
const SYN_WEIGHT = 0.5;
const SYN_MAP = new Map();
for (const g of SYNONYMS) for (const w of g) SYN_MAP.set(w, [...(SYN_MAP.get(w) ?? []), ...g.filter((x) => x !== w)]);

// The words people use for what a command does, when its summary says it another way ("update a
// tag class" means `push`). Indexed with the command, so they rank like its own text.
const COMMAND_INTENTS = {
  push: 'update change edit modify deploy upload send',
  pull: 'download backport fetch server edits into the package',
  rm: 'delete remove unregister',
  'doc rm': 'delete remove document',
  'doc create': 'upload new document file',
  add: 'create new scaffold resource kind',
  ls: 'list browse enumerate resources',
  get: 'read show fetch inspect one resource document',
  status: 'drift changes what changed out of sync',
  diff: 'compare difference',
  doctor: 'check ready health diagnose connectivity server scope smoke',
  import: 'install deploy package uxpkg onto a target',
  export: 'package archive ship uxpkg',
  'cache-clear': 'refresh cache stale reload',
  run: 'execute smoke test prompt plan',
  verify: 'check lint validate',
  disable: 'stop turn off kill switch handler',
  explain: 'error code meaning',
};

/** A deliberately small suffix stripper: consistent on both sides is all BM25 needs. */
export function stem(w) {
  if (w.length <= 3 || /\d/.test(w) || w.endsWith('ss')) return w; // class, access: not plurals
  for (const [suf, rep] of [['ies', 'y'], ['ing', ''], ['ied', 'y'], ['ed', ''], ['es', ''], ['s', ''], ['e', '']]) {
    if (w.endsWith(suf) && w.length - suf.length >= 3) return w.slice(0, -suf.length) + rep;
  }
  return w;
}

/**
 * Text -> stemmed tokens. Identifiers split AND stay whole ("fd.tagclass-delta" -> fd, tagclass,
 * delta, fdtagclassdelta), camelCase splits too ("RegistrationOrder" -> registration, order), and
 * adjacent words also join ("tag class" -> tagclass) so prose meets identifiers halfway.
 */
export function tokenize(text) {
  const out = [];
  const raw = String(text ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  const words = raw.split(/[^a-z0-9§.\-_]+/).filter(Boolean);
  let prev = null;
  for (const w of words) {
    const parts = w.split(/[.\-_§]+/).filter(Boolean);
    if (parts.length > 1) out.push(stem(parts.join('')));
    for (const p of parts) {
      if (STOP.has(p)) { prev = null; continue; }
      out.push(stem(p));
      if (prev && /^[a-z]+$/.test(prev) && /^[a-z]+$/.test(p)) out.push(stem(prev + p));
      prev = p;
    }
  }
  return out;
}

/** "## §42 — title" / "## 5b. title" / "### A19.1 — title" -> { section: '§42', title } */
export function parseHeading(h) {
  const m = /^§?\s*([A-Z]?\d{1,3}[a-z]?(?:\.\d+)?)\s*(?:—|-|\.|:)\s*(.*)$/.exec(h);
  if (m && m[2]) return { section: `§${m[1]}`, title: m[2].trim() };
  return { section: null, title: h.trim() };
}

function readOptional(abs) {
  try { return readFileSync(abs, 'utf8'); } catch { return null; }
}

/** Split a markdown file into `##`/`###` sections (the `#` title and any preamble are not refs). */
export function markdownSections(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let cur = null;
  let fence = false;
  lines.forEach((l, i) => {
    if (/^\s*```/.test(l)) fence = !fence;
    const m = !fence && /^(#{2,3})\s+(.*\S)\s*$/.exec(l);
    if (m) {
      cur = { heading: m[2], line: i + 1, body: [] };
      out.push(cur);
    } else if (cur && cur.body.length < BODY_LINES && l.trim()) cur.body.push(l);
  });
  return out;
}

/** The static help map, keyed by module name: 'doc rm <id…>  delete …' -> { 'doc-rm': line }. */
function helpMapLines(helpText, moduleNames) {
  const map = {};
  for (const l of String(helpText ?? '').split('\n')) {
    const m = /^ {2}([a-z][\w-]*)(?: ([\w|-]+))?.*?\S {2,}\S/.exec(l);
    if (!m) continue;
    const subs = (m[2] ?? '').split('|');
    const keys = subs.map((s) => `${m[1]}-${s}`).filter((k) => moduleNames.has(k));
    for (const k of keys.length ? keys : [m[1]]) map[k] = (map[k] ? `${map[k]}\n` : '') + l.trim();
  }
  return map;
}

/**
 * Collect the corpus. Command modules are imported (in parallel, each in its own try: a broken
 * module drops out, its help-map line still indexes it).
 */
export async function buildCorpus({ root = UXC_ROOT, helpText = '' } = {}) {
  const docs = [];
  const cmdDir = join(root, 'lib/commands');
  let files = [];
  try { files = readdirSync(cmdDir).filter((f) => f.endsWith('.mjs')).sort(); } catch { /* no commands dir */ }
  const moduleNames = new Set(files.map((f) => f.slice(0, -4)));
  const helpLines = helpMapLines(helpText, moduleNames);
  const mods = await Promise.all(files.map(async (f) => {
    try { return (await import(pathToFileURL(join(cmdDir, f)).href)).default; } catch { return null; }
  }));
  files.forEach((f, i) => {
    const key = f.slice(0, -4);
    if (key === 'help') return; // it lists everything; its own flags (--limit) would only add noise
    const mod = mods[i];
    // the dispatcher's spelling ('mp ls', 'cache-clear'), whatever the module calls itself
    const name = TWO_WORD.includes(key.split('-')[0]) ? key.replace('-', ' ') : key;
    const usage = String(mod?.help ?? '').split('\n')[0].trim() || `uxc ${name}`;
    docs.push({
      type: 'command', id: name, title: name, usage, summary: mod?.summary ?? '', nameTokens: tokenize(name),
      // flag NAMES are dropped: every `--limit` would answer "rate limit"; the summary carries the intent
      text: [name, name, mod?.summary, mod?.help, helpLines[key], COMMAND_INTENTS[name]].filter(Boolean).join('\n')
        .replace(/--[\w-]+/g, ' '),
    });
  });

  for (const e of KB_ENTRIES) {
    docs.push({ type: 'explain', id: e.signature, title: e.signature, text: `${e.signature}\n${e.explanation}` });
  }

  const kinds = readOptional(join(root, KINDS_FILE));
  if (kinds) {
    for (const s of markdownSections(kinds)) {
      const kind = s.heading.split(/\s/)[0];
      docs.push({
        type: 'kind', id: kind, title: s.heading, file: KINDS_FILE, line: s.line,
        text: `${kind} ${kind} ${s.heading}\n${s.body.join('\n')}`,
      });
    }
  }

  for (const k of KNOWLEDGE_FILES) {
    const text = readOptional(join(root, k.path));
    if (!text) continue;
    for (const s of markdownSections(text)) {
      const { section, title } = parseHeading(s.heading);
      docs.push({
        type: 'learning', id: `${k.label}${section ? ` ${section}` : ''}`, source: k.label, section, title,
        file: k.path, line: s.line,
        // heading counted twice: the author's summary of the section beats a passing mention
        text: `${s.heading}\n${s.heading}\n${s.body.join('\n')}`,
      });
    }
  }
  return docs;
}

/** BM25 (k1 1.2, b 0.75) over the corpus; returns docs with a score, best first. */
export function rank(docs, query, { k1 = 1.2, b = 0.75 } = {}) {
  const terms = new Map(); // term -> weight (exact 1, synonym SYN_WEIGHT)
  for (const t of tokenize(query)) {
    terms.set(t, 1);
    for (const s of SYN_MAP.get(t) ?? []) if (!terms.has(s)) terms.set(s, SYN_WEIGHT);
  }
  if (!terms.size) return [];
  const tfs = docs.map((d) => {
    const tf = new Map();
    for (const t of tokenize(d.text)) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { tf, len: [...tf.values()].reduce((a, n) => a + n, 0) };
  });
  const avg = tfs.reduce((a, x) => a + x.len, 0) / Math.max(1, tfs.length);
  const df = new Map();
  for (const t of terms.keys()) df.set(t, tfs.filter((x) => x.tf.has(t)).length);
  const N = docs.length;
  const scored = [];
  docs.forEach((d, i) => {
    const { tf, len } = tfs[i];
    let score = 0;
    let matched = 0;
    for (const [t, w] of terms) {
      const f = tf.get(t);
      if (!f) continue;
      if (w === 1) matched++;
      const n = df.get(t);
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += w * idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * len / avg));
    }
    // coverage bonus: a doc that meets MORE of the question beats one that repeats one word
    score *= 1 + matched / terms.size;
    // a command whose NAME is the question's verb or object ("update" -> push, "document" -> doc)
    // is the answer, even when its one-line summary says it differently
    if (d.nameTokens) score *= 1 + 0.75 * d.nameTokens.filter((t) => terms.has(t)).length;
    if (score > 0) scored.push({ doc: d, score, order: i });
  });
  return scored.sort((x, y) => y.score - x.score || x.order - y.order);
}

/**
 * The public entry: { query, commands: [...], refs: [...] }. `limit` caps the total; commands take
 * at most a third of it (rounded up) — the refs are the part an agent cannot get from `uxc help`.
 */
export async function helpSearch(query, { limit = 8, root = UXC_ROOT, helpText = '' } = {}) {
  const docs = await buildCorpus({ root, helpText });
  const abs = (d) => (d.file ? join(root, d.file) : undefined);
  const ranked = rank(docs, query);
  // relevance cut per group: a command's name bonus must not starve the refs, nor the reverse
  const cutoff = (list) => list.filter((r) => r.score >= (list[0]?.score ?? 0) * 0.25);
  const cmdHits = cutoff(ranked.filter((r) => r.doc.type === 'command'));
  const refHits = cutoff(ranked.filter((r) => r.doc.type !== 'command'));
  const round = (n) => Math.round(n * 100) / 100;
  const maxCmd = Math.max(1, Math.ceil(limit / 3));
  const commands = cmdHits.slice(0, maxCmd)
    .map((r) => ({ name: r.doc.id, usage: r.doc.usage, summary: r.doc.summary, score: round(r.score) }));
  const refs = refHits.slice(0, Math.max(0, limit - commands.length))
    .map((r) => ({ ...refView(r.doc, round(r.score)), ...(r.doc.file ? { path: abs(r.doc) } : {}) }));
  return { query, commands, refs };
}

function refView(d, score) {
  if (d.type === 'explain') return { type: 'explain', ref: `explain ${d.id}`, title: d.id, command: `uxc explain "${d.id}"`, score };
  if (d.type === 'kind') return { type: 'kind', ref: `kinds.md ${d.id}`, title: d.title, file: d.file, line: d.line, score };
  return { type: 'learning', ref: d.id, source: d.source, section: d.section, title: d.title, file: d.file, line: d.line, score };
}

/** Human rendering: ≤ limit + 2 lines. */
export function formatHelpSearch({ query, commands, refs }, { width = 110 } = {}) {
  const cut = (s) => (s.length > width ? `${s.slice(0, width - 1)}…` : s);
  if (!commands.length && !refs.length) return [`no match for "${query}" — try other words, or: uxc help`];
  const lines = [];
  if (commands.length) {
    lines.push('commands:');
    // a long usage line would push the summary off screen: cap it, the summary says what it does
    const short = (u) => (u.length > 60 ? `${u.slice(0, 59)}…` : u);
    for (const c of commands) lines.push(cut(`  ${short(c.usage)}${c.summary ? `  — ${c.summary}` : ''}`));
  }
  if (refs.length) {
    lines.push('knowledge:');
    for (const r of refs) {
      const where = r.file ? `  ${r.file}:${r.line}` : `  ${r.command}`;
      const head = r.type === 'learning' ? `${r.ref} — ${r.title}` : r.type === 'kind' ? `kinds.md — ${r.title}` : `explain — ${r.title}`;
      const room = Math.max(30, width - where.length - 2);
      lines.push(`  ${head.length > room ? `${head.slice(0, room - 1)}…` : head}${where}`);
    }
  }
  return lines;
}
