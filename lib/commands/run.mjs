// uxc run <promptId> — run a prompt (or goal, --goal) through the gateway via lib/run.mjs.
// Payload precedence: --fixture payload UNDER --payload-json UNDER explicit --payload k=v.
// --expect tests the FULL answer (the --max-chars cap is display-only) and prints PASS/FAIL +
// the first 400 chars; exit 1 on expect-fail or gateway error.
import { readFileSync } from 'node:fs';
import { runPrompt } from '../run.mjs';
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
  summary: 'run a prompt/goal via the gateway (--payload k=v… --expect --fixture)',
  help: 'uxc run <promptId> [--payload k=v]… [--payload-json f] [--goal] [--provider p] [--model m] ' +
    '[--temperature t] [--expect regex] [--max-chars 2000] [--fixture name] [--save-fixture name]',
  async run(ctx) {
    // `uxc run --goal summarize` parses as flags.goal='summarize' — accept both spellings
    const id = ctx.args[0] ?? (typeof ctx.flags.goal === 'string' ? ctx.flags.goal : null);
    if (!id) fail('usage: uxc run <promptId> [--payload k=v]… [--goal] [--expect regex]');
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

    const res = await runPrompt(ctx, id, {
      payload,
      goal: !!ctx.flags.goal,
      provider: ctx.flags.provider,
      model: ctx.flags.model,
      temperature: ctx.flags.temperature,
      maxChars: Number(ctx.flags['max-chars'] ?? 2000),
      expect: ctx.flags.expect ?? null,
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
