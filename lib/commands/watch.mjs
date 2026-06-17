// uxc watch <docId> — poll a document and print ONLY changed tag values, one line per change:
//   HH:MM:SS Tag: old -> new        (each side truncated at 80)
// If a package is present and a handler was deployed within the last ~45s, the activation blind
// window (learnings §12: events in it are MISSED, no retro-fire) is printed and slept out BEFORE
// the first poll — so "deploy && watch && create" can never lose the triggering event silently.
import { parseDuration, sleep, tagsOf, truncate } from '../util.mjs';
import { FOOTNOTES } from '../explain.mjs';
import { findPackageDir } from '../config.mjs';
import { openPackage } from '../registry.mjs';
import { fail } from '../output.mjs';

const HANDLER_WINDOW_MS = 45_000;
const hhmmss = () => new Date().toTimeString().slice(0, 8);

function optionalPkg(ctx) {
  if (ctx.pkg) return ctx.pkg;
  const dir = ctx.flags.dir ?? findPackageDir();
  if (!dir) return null;
  try { ctx.pkg = openPackage(dir); } catch { return null; }
  return ctx.pkg;
}

export default {
  name: 'watch',
  summary: "poll a document for tag changes (--until 'Tag=V' --interval 10 --timeout 300)",
  help: "uxc watch <docId> [--fields a,b] [--until 'Tag=V'] [--interval 10] [--timeout 300]",
  async run(ctx) {
    const docId = ctx.args[0];
    if (!docId) fail("usage: uxc watch <docId> [--fields a,b] [--until 'Tag=V'] [--interval 10] [--timeout 300]");
    const interval = parseDuration(ctx.flags.interval ?? '10s');
    const timeout = parseDuration(ctx.flags.timeout ?? '300s');
    const fieldsSet = ctx.flags.fields
      ? new Set(String(ctx.flags.fields).split(',').map((s) => s.trim()).filter(Boolean))
      : null;
    let until = null;
    if (ctx.flags.until) {
      const eq = String(ctx.flags.until).indexOf('=');
      if (eq < 1) fail(`bad --until "${ctx.flags.until}" — expected Tag=Value`);
      until = { tag: String(ctx.flags.until).slice(0, eq), value: String(ctx.flags.until).slice(eq + 1) };
    }

    ctx.connect();

    // handler activation blind window: sleep it out BEFORE the first poll
    const pkg = optionalPkg(ctx);
    if (pkg) {
      const resources = pkg.targetState(ctx.target.name).resources ?? {};
      let latest = 0;
      for (const [key, st] of Object.entries(resources)) {
        if (key.startsWith('fd.handler/') && st?.deployedAt) {
          latest = Math.max(latest, Date.parse(st.deployedAt) || 0);
        }
      }
      const remaining = latest + HANDLER_WINDOW_MS - Date.now();
      if (remaining > 0) {
        ctx.out.note(FOOTNOTES.handlerWindow(Math.ceil(remaining / 1000)));
        await sleep(remaining);
      }
    }

    const { core } = ctx.clients;
    const t0 = Date.now();
    let prev = null;
    let changes = 0;
    let untilMet = false;
    let gone = false;

    for (;;) {
      const doc = await core.getDoc(docId);
      if (!doc) {
        if (prev === null) fail(`document ${docId} not found`);
        ctx.out.line(`${hhmmss()} document ${docId} GONE`);
        gone = true;
        break;
      }
      const all = tagsOf(doc);
      const tags = fieldsSet
        ? Object.fromEntries(Object.entries(all).filter(([k]) => fieldsSet.has(k)))
        : all;
      if (prev) {
        for (const k of new Set([...Object.keys(prev), ...Object.keys(tags)])) {
          if (prev[k] !== tags[k]) {
            changes++;
            ctx.out.line(`${hhmmss()} ${k}: ${truncate(prev[k] ?? '(unset)', 80)} -> ${truncate(tags[k] ?? '(unset)', 80)}`);
          }
        }
      }
      prev = tags;
      if (until && String(all[until.tag] ?? '') === until.value) { untilMet = true; break; }
      if (Date.now() - t0 + interval > timeout) break;
      await sleep(interval);
    }

    const elapsed = Math.round((Date.now() - t0) / 1000);
    const untilNote = until ? (untilMet ? `; --until met (${until.tag}=${until.value})` : `; --until NOT met (${until.tag}=${until.value})`) : '';
    ctx.out.line(`watched ${docId} for ${elapsed}s: ${changes} change(s)${untilNote}${gone ? '; document deleted' : ''}`);
    if (ctx.out.json) ctx.out.result({ docId, elapsedSeconds: elapsed, changes, untilMet: until ? untilMet : null, gone });
    if (until && !untilMet) process.exitCode = 1; // timeout (or deletion) with an unmet expectation
  },
};
