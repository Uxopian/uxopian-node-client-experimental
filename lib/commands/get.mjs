// uxc get <kind|doc> <id> — read ONE thing, token-cheap (DESIGN §12):
//  - registry/kind resources: JSON kinds print canonicalText; content-bearing kinds print meta +
//    a 'content: <path> (N bytes, sha)' line — bytes dumped only with --full;
//  - bare document ids (not in the registry): header + aligned tag table (values truncated 120);
//    --fields filters tags; --content writes the bytes to ./<docId>.<ext> (+ path/size/sha);
//    --raw-tag <name> prints ONE tag's value and nothing else, so a TEXT tag holding JSON
//    (PoCaseLog, PoObligationState…) can be piped into jq instead of regexed out of a table.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KINDS } from '../kinds/index.mjs';
import { canonicalText } from '../canonical.mjs';
import { sha256 } from '../util.mjs';
import { findPackageDir } from '../config.mjs';
import { openPackage } from '../registry.mjs';
import { fail } from '../output.mjs';

function optionalPkg(ctx) {
  if (ctx.pkg) return ctx.pkg;
  const dir = ctx.flags.dir ?? findPackageDir();
  if (!dir) return null;
  try { ctx.pkg = openPackage(dir); } catch { return null; }
  return ctx.pkg;
}

async function getResource(ctx, entry, kindName, id) {
  const adapter = KINDS[kindName];
  const server = await adapter.readServer(ctx, id);
  if (!server) fail(`${kindName}/${id}: not found on ${ctx.target.name}`);
  const contents = server.contents ?? {};
  const meta = canonicalText(kindName, server.obj);

  if (ctx.out.json) {
    const cJson = Object.fromEntries(Object.entries(contents).map(([rel, buf]) => [rel, {
      bytes: buf.length, sha256: sha256(buf), ...(ctx.flags.full ? { text: buf.toString('utf8') } : {}),
    }]));
    return ctx.out.result({ kind: kindName, id, obj: server.obj, contents: cJson });
  }

  process.stdout.write(meta);
  for (const [rel, buf] of Object.entries(contents)) {
    const path = entry?.path ? join(entry.path, rel) : rel;
    ctx.out.line(`content: ${path} (${buf.length} bytes, ${sha256(buf)})`);
    if (ctx.flags.full) {
      ctx.out.line(`--- ${rel} ---`);
      process.stdout.write(buf.toString('utf8'));
      if (!buf.toString('utf8').endsWith('\n')) ctx.out.line('');
    }
  }
  if (ctx.flags.content) {
    for (const [rel, buf] of Object.entries(contents)) {
      if (entry?.path) ctx.out.line(`content file: ${join(entry.path, rel)} (managed in the package)`);
      else {
        const out = `./${rel.replace(/.*\//, '')}`;
        writeFileSync(out, buf);
        ctx.out.line(`${out}  ${buf.length} bytes  ${sha256(buf)}`);
      }
    }
  }
}

/** A bare id may name a DOCUMENT or a VIRTUAL FOLDER — they live on different endpoints, and
 *  reading only documents is why inspecting a case from the CLI was impossible (BACKLOG #18).
 *  Both answer the same component shape, so one renderer serves both. */
async function readComponent(ctx, id) {
  const doc = await ctx.clients.core.getDoc(id);
  if (doc) return { obj: doc, category: 'document' };
  const vf = await ctx.clients.core.getOne(`/rest/virtualFolder/${encodeURIComponent(id)}`);
  if (vf) return { obj: vf, category: 'virtual folder' };
  return null;
}

async function getDocument(ctx, id) {
  const found = await readComponent(ctx, id);
  if (!found) {
    fail(`no document and no virtual folder with id ${id} on ${ctx.target.name}`
      + ` (and "${id}" is not a registry resource) — uxc search '${id}' --category VIRTUAL_FOLDER to look it up`);
  }
  const { obj: doc, category } = found;
  let tags = doc.tags ?? [];

  // --raw-tag: one tag's value, verbatim, nothing else on stdout (notes/errors go to stderr).
  if (ctx.flags['raw-tag']) {
    const want = String(ctx.flags['raw-tag']);
    const t = tags.find((x) => x.name === want);
    if (!t) {
      fail(`${category} ${id} has no tag "${want}" — it carries: ${tags.map((x) => x.name).sort().join(', ') || '(no tags)'}`);
    }
    const values = (Array.isArray(t.value) ? t.value : [t.value]).map((v) => (v == null ? '' : String(v)));
    if (ctx.out.json) return ctx.out.result({ id: doc.id ?? id, tag: want, value: values });
    for (const v of values) process.stdout.write(v.endsWith('\n') ? v : `${v}\n`);
    return undefined;
  }

  if (ctx.flags.fields) {
    const want = new Set(String(ctx.flags.fields).split(',').map((s) => s.trim()));
    tags = tags.filter((t) => want.has(t.name));
  }
  if (ctx.out.json) {
    ctx.out.result({
      id: doc.id ?? id, category, classId: doc.data?.classId, status: doc.status, version: doc.data?.version,
      name: doc.name, tags: Object.fromEntries(tags.map((t) => [t.name, t.value])),
      files: (doc.files ?? []).map((f) => ({ id: f.id, name: f.name, formatCode: f.formatCode })),
    });
  } else {
    ctx.out.line(`${doc.id ?? id}  ${category}  classId=${doc.data?.classId ?? '?'}  status=${doc.status ?? ''}  version=${doc.data?.version ?? ''}`);
    ctx.out.table(
      tags.map((t) => ({ tag: t.name, value: (t.value ?? []).join(' | ') })),
      [{ key: 'tag' }, { key: 'value', max: ctx.flags.full ? 1e9 : 120 }],
    );
  }
  if (ctx.flags.content) {
    const file = doc.files?.[0];
    if (!file) fail(`${category} ${id} has no content file`);
    const bytes = await ctx.clients.core.getContent(id, file.id);
    const fmt = String(file.formatCode ?? '').toLowerCase();
    const ext = /^[a-z0-9]{1,5}$/.test(fmt) ? fmt : 'bin';
    const out = `./${id}.${ext}`;
    writeFileSync(out, bytes ?? Buffer.alloc(0));
    ctx.out.line(`${out}  ${bytes?.length ?? 0} bytes  ${sha256(bytes ?? Buffer.alloc(0))}`);
  }
}

export default {
  name: 'get',
  summary: 'read one resource or document (--fields --raw-tag --content --full)',
  help: 'uxc get <kind> <id> | uxc get <kind/id> | uxc get <docId> [--fields a,b] [--raw-tag Name] [--content] [--full]',
  lock: 'read',
  async run(ctx) {
    const a = ctx.args;
    if (!a.length) fail('usage: uxc get <kind|doc> <id> [--fields …] [--content] [--full]');

    // `uxc get doc <id>` / `get document <id>`: there is no "doc" kind, so a[0] used to BE the id
    // and the answer was `document doc not found` — which reads as "your document is missing"
    // when it means "drop the word doc". Accept the noise word instead of punishing it.
    if (a.length >= 2 && /^(doc|document|documents)$/i.test(a[0])) {
      ctx.out.note(`"uxc get ${a[0]} <id>" — the word "${a[0]}" is not needed: uxc get <docId>`);
      a.shift();
    }

    let kindName = null;
    let id = null;
    if (a.length >= 2 && KINDS[a[0]]) { kindName = a[0]; id = a[1]; }
    else if (a[0].includes('/') && KINDS[a[0].slice(0, a[0].indexOf('/'))]) {
      kindName = a[0].slice(0, a[0].indexOf('/'));
      id = a[0].slice(a[0].indexOf('/') + 1);
    } else id = a[0];

    const pkg = optionalPkg(ctx);
    let entry = null;
    if (kindName) entry = pkg?.entry(kindName, id) ?? null;
    else if (pkg) {
      try { entry = pkg.resolve(id); } catch (e) { fail(e.message); }
      if (entry) { kindName = entry.kind; id = entry.id; }
    }

    ctx.connect();
    if (kindName) return getResource(ctx, entry, kindName, id);
    return getDocument(ctx, id); // bare doc id: straight Core read
  },
};
