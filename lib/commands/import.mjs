// uxc import — unpack/remap/pre-flight/push a package onto the target (DESIGN §10).
// The whole package is pre-flighted against the no-base matrix and the FULL collision list
// printed BEFORE any write; --force overwrites collisions. Resumable: state commits per resource.
import { readFileSync } from 'node:fs';
import { importPackage } from '../packageio.mjs';
import { collectRepeatedFlag, kvPairs } from '../util.mjs';
import { fail } from '../output.mjs';

const reclaim = (flags, args, name) => {
  const v = flags[name];
  if (typeof v === 'string') args.push(v);
  return v !== undefined && v !== false;
};

export default {
  name: 'import',
  summary: 'import a .uxpkg/dir onto the target (pre-flight collisions, ordered push, verify)',
  help: 'uxc import <pkg.uxpkg|dir> [--var name=value]… [--var-file values.json] [--code-remap old=new] [--force] [--expect-sha256 <hash>] [--ignore-client-version] [--ignore-server-version]',
  async run(ctx) {
    const { flags, out } = ctx;
    const args = [...ctx.args];
    const force = reclaim(flags, args, 'force');
    const ignoreClientVersion = reclaim(flags, args, 'ignore-client-version');
    const ignoreServerVersion = reclaim(flags, args, 'ignore-server-version');
    const src = args[0];
    if (!src) fail('usage: uxc import <pkg.uxpkg|dir> [--code-remap old=new] [--force] [--expect-sha256 <hash>] [--ignore-client-version]');
    const remap = typeof flags['code-remap'] === 'string' ? flags['code-remap'] : null;
    if (remap && !/^[a-z][a-z0-9]*=[a-z][a-z0-9]*$/.test(remap)) {
      fail(`--code-remap expects old=new project codes (got "${remap}")`);
    }
    // Security gate: verify the archive's sha256 before any server write (see importPackage).
    const expectSha256 = typeof flags['expect-sha256'] === 'string' ? flags['expect-sha256'] : null;
    ctx.connect();

    // package variables (DESIGN §21): --var repeatable + --var-file
    const vars = kvPairs(collectRepeatedFlag('var'));
    const varFile = typeof flags['var-file'] === 'string' ? JSON.parse(readFileSync(flags['var-file'], 'utf8')) : {};
    const res = await importPackage(ctx, src, { remap, force, expectSha256, ignoreClientVersion, ignoreServerVersion, vars, varFile });
    if (Array.isArray(res)) {
      for (const a of res) out.line(`${String(a.action ?? '').padEnd(12)} ${a.id}${a.detail ? '  ' + a.detail : ''}`);
      out.line(`import: ${res.length} resources`);
    } else if (res && typeof res === 'object') {
      for (const [k, v] of Object.entries(res)) {
        out.line(`${k}: ${Array.isArray(v) ? v.length : typeof v === 'object' && v ? JSON.stringify(v).slice(0, 120) : v}`);
      }
    } else {
      out.line('import complete');
    }
    out.result(res ?? { src });
  },
};
