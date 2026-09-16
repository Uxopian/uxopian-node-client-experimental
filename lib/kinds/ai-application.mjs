// ai.application — Applications (uxopian-ai 2026.0.0-ft5+, dialect cap `applications`): the AI
// configuration of one calling surface, resolved per chat context from the X-Application-Id request
// header (uxc run --application). An application = { name, description, provider (connection
// provider, e.g. FlowerDocsProvider), prompt (appended to the base prompt), defaultLlmProvider,
// defaultLlmModel, maxToolCycles, permissions {…same block as ai.agent} }.
// Verified on fd.demo 2026-09-16 (AI learnings §A15):
//   - CRUD /api/v1/admin/application/application-conf[/{id}]; create 201 with an EMPTY body; an
//     existing name is a 409 "Application already exists for name"; PUT /{id} is a FULL replace.
//   - the id is DERIVED FROM `name` — a client-sent id that differs is silently ignored, so uxc
//     keeps name === id and refuses anything else.
//   - the gateway auto-creates one application per connection provider (`default`, `FlowerDocs`
//     on IRIS) — shared, never project-prefixed: adopt them as external if a package needs them.
//   - a prompt an application references cannot be deleted (409) — and stays "referenced" for a
//     couple of seconds AFTER the application is deleted (ai-prompt remove retries).
//   - the precedence of the LLM choice: request override > the turn's prompt > the application
//     default > the system default (a prompt without provider/model ran on the app's model).
import { join } from 'node:path';
import { jsonLayout } from './base.mjs';
import { agenticCrud, idErrors, toolWarnings } from './ai-agentic.mjs';
import { capabilities } from '../dialects.mjs';

const KIND = 'ai.application';
const DIR = 'ai/applications';
const layout = jsonLayout({ kind: KIND, dir: DIR });

/** Null when the gateway has Applications; else why not. */
export async function applicationSupport(ctx) {
  const { caps, dialect } = await capabilities(ctx, 'uxopian-ai');
  if (caps.applications) return null;
  return `${KIND} needs uxopian-ai 2026.0.0-ft5+ (Applications) — this gateway resolves to dialect ${dialect}`;
}

const crud = agenticCrud({ kind: KIND, base: '/api/v1/admin/application/application-conf', support: applicationSupport, conflictStatus: 409 });

/** The body the gateway keys correctly: name carries the id. */
const withName = (obj, id) => ({ ...obj, id, name: obj.name ?? id });

const adapter = {
  kind: KIND,
  dir: DIR,
  layout: 'json',
  defaultPolicy: 'managed',
  cacheAffecting: false,

  pathFor: (pkg, id) => join(DIR, `${id}.json`),
  serverSupport: applicationSupport,

  list: crud.list,
  get: crud.get,

  async readServer(ctx, id) {
    const app = await crud.get(ctx, id);
    return app ? { obj: app } : null;
  },

  readLocal: layout.readLocal,
  writeLocal: layout.writeLocal,
  removeLocal: layout.removeLocal,

  async create(ctx, { obj }) { await crud.create(ctx, withName(obj, obj.id)); },
  async update(ctx, id, { obj }) { await crud.update(ctx, id, withName(obj, id)); },
  remove: crud.remove,

  validate(pkg, entry, local) {
    const o = local?.obj ?? {};
    const errs = idErrors(entry, o);
    if (o.name != null && o.name !== entry.id) {
      errs.push(`name "${o.name}" differs from the id "${entry.id}" — the gateway derives an application's id from its name, so they must match`);
    }
    if (o.maxToolCycles != null && !(Number.isInteger(o.maxToolCycles) && o.maxToolCycles > 0)) {
      errs.push('maxToolCycles must be a positive integer (or absent for the system default)');
    }
    return errs;
  },

  /** Network lint (warnings): tool names / tags the gateway does not register. */
  async lintHelpers(ctx, local) { return toolWarnings(ctx, local?.obj?.permissions); },

  template(ctx, name, flags = {}) {
    const str = (v) => (typeof v === 'string' ? v : undefined);
    return {
      obj: {
        id: name,
        name,
        description: str(flags.title) ?? '',
        provider: str(flags.provider) ?? 'FlowerDocsProvider',
        ...(str(flags.prompt) ? { prompt: flags.prompt } : {}),
      },
    };
  },

  scan: crud.scan,
};

export default adapter;
