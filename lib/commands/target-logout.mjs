// uxc target logout [<name>] [--all] — forget the cached fast2 broker token (FAST-5884).
// Local only: deletes ~/.uxopian/f2-tokens/<key>.json, makes no broker call. The next f2 command
// logs in again. targets.json (and the password in it) is not touched.
import { resolveTarget } from '../config.mjs';
import { dropToken, dropAllTokens, tokenCacheDir } from '../f2/token-cache.mjs';

export default {
  name: 'target-logout',
  summary: 'forget the cached fast2 token of a target (--all: every cached token); local, no broker call',
  help: 'uxc target logout [<name>] [--all]',
  async run(ctx) {
    const { args, flags, out } = ctx;
    if (flags.all) {
      const removed = dropAllTokens();
      out.line(`${removed} cached fast2 token${removed === 1 ? '' : 's'} removed (${tokenCacheDir()})`);
      out.result({ all: true, removed });
      return;
    }
    const t = resolveTarget(args[0]);
    if (!t.f2 || !t.f2User) {
      out.line(`target ${t.name ?? '(env)'} has no fast2 broker credentials — nothing is cached for it`);
      out.result({ target: t.name ?? null, f2: t.f2 ?? null, removed: false });
      return;
    }
    const removed = dropToken({ broker: t.f2, user: t.f2User });
    out.line(removed
      ? `target ${t.name ?? '(env)'}: cached fast2 token removed — the next f2 command logs in again`
      : `target ${t.name ?? '(env)'}: no cached fast2 token`);
    out.result({ target: t.name ?? null, f2: t.f2, removed });
  },
};
