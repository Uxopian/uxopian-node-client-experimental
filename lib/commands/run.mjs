// uxc run <promptId> — run a prompt (or goal, --goal) through the gateway via lib/run.mjs;
// uxc run --plan <planId> — run an ai.plan to completion (runPlan, uxopian-ai 2026.0.0-ft5+).
// Payload precedence: --fixture payload UNDER --payload-json UNDER explicit --payload k=v.
// --expect tests the FULL answer (the --max-chars cap is display-only) and prints PASS/FAIL +
// the first 400 chars; exit 1 on expect-fail or gateway error.
import { readFileSync } from 'node:fs';
import { runPrompt, runPlan } from '../run.mjs';
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

function optionalPkg(ctx) {
  if (ctx.pkg) return ctx.pkg;
  const dir = ctx.flags.dir ?? findPackageDir();
  if (!dir) return null;
  try { ctx.pkg = openPackage(dir); } catch { return null; }
  return ctx.pkg;
}

export default {
  name: 'run',
  summary: 'run a prompt, goal or plan via the gateway (--payload k=v… --expect --fixture)',
  help: 'uxc run <promptId> [--payload k=v]… [--payload-json f] [--prompt-version n] [--application id] [--goal] [--provider p] [--model m] ' +
    '[--temperature t] [--expect regex] [--max-chars 2000] [--timeout s] [--fixture name] [--save-fixture name]\n' +
    '       uxc run --plan <planId> [--payload k=v]… [--payload-json f] [--expect regex] [--timeout s]   (uxopian-ai 2026.0.0-ft5+)',
  async run(ctx) {
    // `uxc run --goal summarize` / `--plan p` parse as flags.goal='summarize' — accept both spellings
    const id = ctx.args[0]
      ?? (typeof ctx.flags.goal === 'string' ? ctx.flags.goal : null)
      ?? (typeof ctx.flags.plan === 'string' ? ctx.flags.plan : null);
    if (!id) fail('usage: uxc run <promptId> [--payload k=v]… [--goal] [--expect regex]  |  uxc run --plan <planId> [--payload k=v]…');
    const plan = ctx.flags.plan !== undefined && ctx.flags.plan !== false;
    if (plan && ctx.flags.goal) fail('--plan and --goal are exclusive');
    ctx.connect();
    const pkg = optionalPkg(ctx);

    // ---- payload assembly: fixture UNDER json UNDER explicit k=v ----
    let payload = {};
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

    const timeoutMs = ctx.flags.timeout ? { timeoutMs: Number(ctx.flags.timeout) * 1000 } : {};
    if (plan) {
      const res = await runPlan(ctx, id, {
        payload,
        expect: ctx.flags.expect ?? null,
        maxChars: Number(ctx.flags['max-chars'] ?? 2000),
        onProgress: (p) => { if (!ctx.out.json) ctx.out.note(p); },
        ...timeoutMs,
      });
      if (ctx.out.json) return ctx.out.result(res);
      const elapsed = `(${(res.elapsedMs / 1000).toFixed(1)}s)`;
      ctx.out.line(`${res.status} ${elapsed}${res.executionId ? `  execution ${res.executionId}` : ''}`);
      for (const n of res.nodes) {
        const out = n.error ?? String(n.output ?? '').replace(/\s+/g, ' ').slice(0, 100);
        ctx.out.line(`  ${String(n.id).padEnd(16)} ${String(n.type ?? '').padEnd(11)} ${String(n.status).padEnd(11)} ${out}`);
      }
      if (res.error) {
        ctx.out.warn(`plan ${id}: ${res.error}`);
        process.exitCode = 1;
      }
      if (ctx.flags.expect) {
        ctx.out.line(res.pass ? 'PASS' : 'FAIL');
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
      ctx.out.line(res.answer.slice(0, 400));
      if (!res.pass) process.exitCode = 1;
    } else {
      ctx.out.line(elapsed);
      ctx.out.line(res.answer); // already capped at --max-chars by runPrompt
    }
  },
};
