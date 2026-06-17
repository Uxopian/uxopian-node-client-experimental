// uxc cache-clear — DELETE /gui/rest/caches + /core/rest/caches, and clear a dangling
// pendingCacheClear flag in the package state (any earlier failed push leaves one).
import { findPackageDir } from '../config.mjs';
import { openPackage } from '../registry.mjs';

function optionalPkg(ctx) {
  if (ctx.pkg) return ctx.pkg;
  const dir = ctx.flags.dir ?? findPackageDir();
  if (!dir) return null;
  try { ctx.pkg = openPackage(dir); } catch { return null; }
  return ctx.pkg;
}

export default {
  name: 'cache-clear',
  summary: 'clear GUI + Core caches; resets pendingCacheClear in package state',
  help: 'uxc cache-clear',
  async run(ctx) {
    ctx.connect();
    const statuses = await ctx.clients.cacheClear(); // throws (with the manual fallback) on GUI >= 400
    ctx.out.line(`DELETE /gui/rest/caches -> ${statuses.gui}`);
    ctx.out.line(`DELETE /core/rest/caches -> ${statuses.core}`);

    const pkg = optionalPkg(ctx);
    if (pkg && pkg.targetState(ctx.target.name).pendingCacheClear) {
      pkg.setPendingCacheClear(ctx.target.name, false);
      ctx.out.note('pendingCacheClear flag cleared in .uxc/state.json');
    }
    if (ctx.out.json) ctx.out.result(statuses);
  },
};
