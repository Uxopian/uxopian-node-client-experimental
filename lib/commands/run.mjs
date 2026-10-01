// uxc run <promptId> — run a prompt (or goal, --goal) through the gateway via lib/run.mjs;
// --image <path> (repeatable) rides the bytes INLINE as an ft5 IMAGE content item, which is the
// only route to a multimodal prompt when the FlowerDocs/ARender connector beans are not wired
// (UXOPIAN-AI-LEARNINGS §A19, FLOWERDOCS-LEARNINGS §29).
// uxc run --plan <planId> — run an ai.plan to completion (runPlan, uxopian-ai 2026.0.0-ft5+).
// Payload precedence: --fixture payload UNDER --payload-json UNDER explicit --payload k=v.
// --expect tests the FULL answer (the --max-chars cap is display-only) and prints PASS/FAIL +
// the first 400 chars; exit 1 on expect-fail or gateway error. The regex runs on the raw text, then
// on the JSON inside it — strict first, then repaired by lib/jsonloose.mjs (a ```json fence, prose,
// trailing commas, smart/single quotes) — and a pass that needed a repair says so (#122).
// Every --plan run is recorded (lib/run.mjs runsDir: <pkg>/.uxc/runs, else ~/.uxopian/runs);
// --retry [<executionId>] re-runs the plan with that record's payload (default: the newest run of
// the plan on this target) — a FULL re-run, the gateway has no per-node re-run (AI learnings §A16) —
// and prints both runs node by node.
import { readFileSync } from 'node:fs';
import { extname, basename } from 'node:path';
import {
  runPrompt, runPlan, runsDir, planRunRecord, recordPlanRun, findPlanRun, comparePlanRuns,
} from '../run.mjs';
import { findPackageDir } from '../config.mjs';
import { openPackage } from '../registry.mjs';
import { fail } from '../output.mjs';

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

// What the providers actually accept. An unknown extension is REFUSED rather than guessed: a wrong
// mime is not a 400 from the gateway, it is a closed socket (§A19).
const IMAGE_MIMES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp',
};

// Size (#76). The bytes ride base64-encoded INSIDE the JSON body (+33%), through the ingress, the
// gateway and on to the provider, and each hop has a ceiling: OpenAI documents 20 MB per image,
// Anthropic 5 MB. Only a 344 KiB image is verified end to end (§A19.3). An oversized body is not
// guaranteed a clean 413 — it can come back as a closed socket, which uxc would otherwise explain as
// a broken helper bean (§29). So: refuse above the largest provider cap, warn above the smallest.
export const IMAGE_WARN_BYTES = 5 * 1024 * 1024;
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const mib = (n) => `${(n / 1024 / 1024).toFixed(1)} MiB`;

/** null when fine; { error } above the hard cap; { warning } above the smallest provider cap. */
export function imageSizeVerdict(name, size) {
  if (size > IMAGE_MAX_BYTES) {
    return { error: `--image ${name}: ${mib(size)} is above the ${mib(IMAGE_MAX_BYTES)} per-image limit of the providers — resize or recompress it` };
  }
  if (size > IMAGE_WARN_BYTES) {
    return {
      warning: `--image ${name}: ${mib(size)} (${mib(Math.ceil(size / 3) * 4)} once base64-encoded) — above some providers' ${mib(IMAGE_WARN_BYTES)} per-image limit;`
        + ' if the run fails with a closed connection or a 413, the size is the likelier cause than a helper bean',
    };
  }
  return null;
}

/** <path> -> `data:<mime>;base64,<bytes>`, the one shape the gateway accepts. */
function imageDataUri(path, warn = () => {}) {
  const ext = extname(path).toLowerCase();
  const mime = IMAGE_MIMES[ext];
  if (!mime) {
    fail(`--image ${basename(path)}: unsupported image type "${ext || '(none)'}" — `
      + `expected one of ${Object.keys(IMAGE_MIMES).join(', ')}`);
  }
  let bytes;
  try { bytes = readFileSync(path); } catch (e) { fail(`--image ${path}: ${e.message}`); }
  const verdict = imageSizeVerdict(basename(path), bytes.length);
  if (verdict?.error) fail(verdict.error);
  if (verdict?.warning) warn(verdict.warning);
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

/** How an --expect pass was reached when the raw text alone did not match (#122). */
export function expectViaNote(res) {
  const where = res.expectNode ? ` (node ${res.expectNode})` : '';
  return res.expectVia === 'json-repaired'
    ? `matched after repairing the JSON${where}: ${(res.repaired ?? []).join(', ')}`
    : `matched the re-serialized JSON${where}, not the raw text`;
}

function optionalPkg(ctx) {
  if (ctx.pkg) return ctx.pkg;
  const dir = ctx.flags.dir ?? findPackageDir();
  if (!dir) return null;
  try { ctx.pkg = openPackage(dir); } catch { return null; }
  return ctx.pkg;
}

export default {
  name: 'run',
  summary: 'run a prompt, goal or plan via the gateway (--payload k=v… --image path… --expect --fixture)',
  help: 'uxc run <promptId> [--payload k=v]… [--payload-json f] [--image path]… [--prompt-version n] [--application id] [--goal] [--provider p] [--model m] ' +
    '[--temperature t] [--expect regex] [--max-chars 2000] [--timeout s] [--fixture name] [--save-fixture name]\n' +
    '       uxc run --plan <planId> [--payload k=v]… [--payload-json f] [--expect regex] [--timeout s]   (uxopian-ai 2026.0.0-ft5+)\n' +
    '       uxc run --plan <planId> --retry [<executionId>] [--expect regex]   re-run with a recorded run\'s payload (default: the last one), both runs side by side\n' +
    '  --expect matches the raw answer, then the JSON in it (strict, then repaired: ```json fences, prose, trailing commas, smart/single quotes — a repaired pass is reported).\n' +
    '  Plan runs are recorded in <package>/.uxc/runs/ (outside a package: ~/.uxopian/runs/, UXC_HOME).',
  async run(ctx) {
    // `uxc run --goal summarize` / `--plan p` parse as flags.goal='summarize' — accept both spellings
    const id = ctx.args[0]
      ?? (typeof ctx.flags.goal === 'string' ? ctx.flags.goal : null)
      ?? (typeof ctx.flags.plan === 'string' ? ctx.flags.plan : null);
    if (!id) fail('usage: uxc run <promptId> [--payload k=v]… [--goal] [--expect regex]  |  uxc run --plan <planId> [--payload k=v]…');
    const plan = ctx.flags.plan !== undefined && ctx.flags.plan !== false;
    if (plan && ctx.flags.goal) fail('--plan and --goal are exclusive');
    const retry = ctx.flags.retry !== undefined && ctx.flags.retry !== false && ctx.flags.retry !== 'false';
    if (retry && !plan) fail('--retry applies to a plan run: uxc run --plan <planId> --retry [<executionId>]');
    if (retry && (ctx.flags.fixture || ctx.flags['payload-json'] || collectFlag('payload').length)) {
      fail('--retry replays the recorded payload — drop --payload/--payload-json/--fixture (or run without --retry)');
    }
    ctx.connect();
    const pkg = optionalPkg(ctx);
    const targetName = ctx.target?.name ?? null;
    const recordsDir = runsDir(pkg?.dir ?? null);
    let previous = null;
    if (retry) {
      const executionId = typeof ctx.flags.retry === 'string' && ctx.flags.retry !== 'true' ? ctx.flags.retry : null;
      try { previous = findPlanRun(recordsDir, id, { executionId, target: targetName }); } catch (e) { fail(e.message); }
    }

    // ---- payload assembly: fixture UNDER json UNDER explicit k=v ----
    let payload = previous ? structuredClone(previous.payload ?? {}) : {};
    if (ctx.flags.fixture) {
      if (!pkg) fail('--fixture needs a package (fixtures live in .uxc/state.json)');
      const fx = pkg.targetState(ctx.target.name).fixtures?.[ctx.flags.fixture];
      if (!fx) fail(`fixture "${ctx.flags.fixture}" not found for target ${ctx.target.name}`);
      payload = { ...fx };
    }
    if (ctx.flags['payload-json']) {
      Object.assign(payload, JSON.parse(readFileSync(String(ctx.flags['payload-json']), 'utf8')));
    }
    for (const kv of collectFlag('payload')) {
      const eq = kv.indexOf('=');
      if (eq < 1) fail(`bad --payload "${kv}" — expected k=v`);
      payload[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
    if (ctx.flags['save-fixture']) {
      if (!pkg) fail('--save-fixture needs a package (fixtures live in .uxc/state.json)');
      const ts = pkg.targetState(ctx.target.name);
      ts.fixtures ??= {};
      ts.fixtures[String(ctx.flags['save-fixture'])] = payload;
      pkg.saveState();
      ctx.out.note(`fixture "${ctx.flags['save-fixture']}" saved for target ${ctx.target.name}`);
    }

    // --image is repeatable, like --payload; ft5+ only (runPrompt gates on the dialect)
    const images = collectFlag('image').map((p) => imageDataUri(p, (w) => ctx.out.warn(w)));
    if (images.length && plan) fail('--image applies to a prompt run, not to --plan');

    const timeoutMs = ctx.flags.timeout ? { timeoutMs: Number(ctx.flags.timeout) * 1000 } : {};
    if (plan) {
      if (previous) {
        ctx.out.note(`retry of execution ${previous.executionId ?? '(rejected)'} (${previous.status}, recorded ${previous.recordedAt}) — `
          + 'FULL re-run with its payload: the gateway has no per-node re-run (AI learnings §A16)');
      }
      const res = await runPlan(ctx, id, {
        payload,
        expect: ctx.flags.expect ?? null,
        maxChars: Number(ctx.flags['max-chars'] ?? 2000),
        onProgress: (p) => { if (!ctx.out.json) ctx.out.note(p); },
        ...timeoutMs,
      });
      // record every run (best-effort: a read-only disk must not turn a good run into a failure)
      const rec = planRunRecord(id, res, { payload, target: targetName, retryOf: previous?.executionId ?? null });
      let recorded = null;
      try { recorded = recordPlanRun(recordsDir, rec); } catch (e) { ctx.out.warn(`could not record the run in ${recordsDir}: ${e.message}`); }
      const comparison = previous ? comparePlanRuns(previous, rec) : null;
      if (ctx.out.json) {
        return ctx.out.result({
          ...res, recorded,
          ...(previous ? {
            retry: {
              of: previous.executionId, previousStatus: previous.status, recordedAt: previous.recordedAt,
              mode: 'full-rerun', reason: 'no per-node re-run on the gateway (AI learnings §A16)', nodes: comparison,
            },
          } : {}),
        });
      }
      const elapsed = `(${(res.elapsedMs / 1000).toFixed(1)}s)`;
      ctx.out.line(`${res.status} ${elapsed}${res.executionId ? `  execution ${res.executionId}` : ''}`);
      const short = (o) => (o == null ? '' : o.error ?? String(o.output ?? '').replace(/\s+/g, ' ').slice(0, 80));
      if (comparison) {
        ctx.out.line(`  ${'node'.padEnd(16)} ${'type'.padEnd(11)} ${'previous'.padEnd(11)} ${'this run'.padEnd(11)} output / error (this run)`);
        for (const r of comparison) {
          ctx.out.line(`  ${String(r.id).padEnd(16)} ${String(r.type ?? '').padEnd(11)} ${String(r.before?.status ?? '-').padEnd(11)} `
            + `${String(r.after?.status ?? '-').padEnd(11)} ${short(r.after ?? r.before)}`);
        }
        ctx.out.line(`  previous: ${previous.status}${previous.executionId ? ` (${previous.executionId})` : ''}  ->  this run: ${res.status}`);
      } else {
        for (const n of res.nodes) {
          const out = n.error ?? String(n.output ?? '').replace(/\s+/g, ' ').slice(0, 100);
          ctx.out.line(`  ${String(n.id).padEnd(16)} ${String(n.type ?? '').padEnd(11)} ${String(n.status).padEnd(11)} ${out}`);
        }
      }
      if (res.error) {
        ctx.out.warn(`plan ${id}: ${res.error}`);
        process.exitCode = 1;
      }
      if (ctx.flags.expect) {
        ctx.out.line(res.pass ? 'PASS' : 'FAIL');
        if (res.pass && res.expectVia) ctx.out.note(expectViaNote(res));
        if (!res.pass) process.exitCode = 1;
      }
      if (res.answer) ctx.out.line(ctx.flags.expect ? res.answer.slice(0, 400) : res.answer);
      return;
    }

    const res = await runPrompt(ctx, id, {
      payload,
      goal: !!ctx.flags.goal,
      version: ctx.flags['prompt-version'] ?? null,
      application: typeof ctx.flags.application === 'string' ? ctx.flags.application : null,
      images,
      provider: ctx.flags.provider,
      model: ctx.flags.model,
      temperature: ctx.flags.temperature,
      maxChars: Number(ctx.flags['max-chars'] ?? 2000),
      expect: ctx.flags.expect ?? null,
      // --timeout <s> caps the gateway wait (default 300s) — automation shouldn't sit through
      // a 5-minute hang when the provider key is empty (§A5)
      ...timeoutMs,
    });

    if (ctx.out.json) ctx.out.result(res);
    const elapsed = `(${(res.elapsedMs / 1000).toFixed(1)}s)`;
    if (res.error) {
      ctx.out.warn(`gateway error ${elapsed}: ${res.error}`);
      process.exitCode = 1;
      return;
    }
    if (ctx.flags.expect) {
      ctx.out.line(`${res.pass ? 'PASS' : 'FAIL'} ${elapsed}`);
      if (res.pass && res.expectVia) ctx.out.note(expectViaNote(res));
      ctx.out.line(res.answer.slice(0, 400));
      if (!res.pass) process.exitCode = 1;
    } else {
      ctx.out.line(elapsed);
      ctx.out.line(res.answer); // already capped at --max-chars by runPrompt
    }
  },
};
