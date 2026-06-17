// uxc doc create <classId> — create ONE document. --tag k=v repeatable (re-collected from argv),
// --file <path> (mime by extension), --id/--name. With --id and an existing doc: hard fail with
// the F00903 explanation (create is NOT an upsert — that protection is the point of this command).
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { tag, fdTimestamp } from '../util.mjs';
import { explainCode } from '../explain.mjs';
import { fail } from '../output.mjs';

const MIME = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xml': 'application/xml',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.png': 'image/png',
};

/** Collect EVERY occurrence of --<name> from argv (the shared parser keeps only the last). */
function collectFlag(name) {
  const argv = process.argv.slice(2);
  const vals = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}`) {
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) vals.push(argv[++i]);
    } else if (argv[i].startsWith(`--${name}=`)) vals.push(argv[i].slice(name.length + 3));
  }
  return vals;
}

export default {
  name: 'doc create',
  summary: 'create a document (--tag k=v… --file path --id --name)',
  help: 'uxc doc create <classId> [--tag k=v]… [--file path] [--id id] [--name name]',
  async run(ctx) {
    const classId = ctx.args[0];
    if (!classId) fail('usage: uxc doc create <classId> [--tag k=v]… [--file path] [--id …] [--name …]');
    ctx.connect();
    const { core } = ctx.clients;

    const tags = collectFlag('tag').map((kv) => {
      const eq = kv.indexOf('=');
      if (eq < 1) fail(`bad --tag "${kv}" — expected k=v`);
      return tag(kv.slice(0, eq), kv.slice(eq + 1));
    });

    const files = [];
    if (ctx.flags.file) {
      const path = String(ctx.flags.file);
      const bytes = readFileSync(path);
      files.push({ bytes, filename: basename(path), mime: MIME[extname(path).toLowerCase()] ?? 'application/octet-stream' });
    }

    const id = ctx.flags.id ? String(ctx.flags.id) : null;
    if (id) {
      const existing = await core.getDoc(id);
      if (existing) {
        const expl = explainCode('F00903')[0]?.explanation ?? '';
        fail(`document ${id} already exists (would be F00903) — ${expl}`);
      }
    }

    const name = ctx.flags.name ? String(ctx.flags.name)
      : ctx.flags.file ? basename(String(ctx.flags.file))
        : id ?? `${classId}-${Date.now()}`;

    const body = {
      ...(id ? { id } : {}),
      name,
      category: 'DOCUMENT',
      data: { classId, owner: ctx.target.user, creationDate: fdTimestamp(), lastUpdateDate: fdTimestamp() },
      tags,
    };

    let createdId;
    if (id) {
      // exists-check done above: upsertDoc takes the create path (fresh tmp per attempt inside)
      const r = await core.upsertDoc(body, files);
      createdId = r.id;
    } else {
      const fileRefs = [];
      for (const f of files) fileRefs.push({ id: await core.uploadTmp(f.bytes, f.filename, f.mime) });
      if (fileRefs.length) body.files = fileRefs;
      const created = await core.post('/rest/documents', [body]);
      createdId = created?.[0]?.id ?? '(created — id not echoed)';
    }

    if (ctx.out.json) return ctx.out.result({ id: createdId, classId, name });
    ctx.out.line(createdId);
  },
};
