// REVIEW P3-8 — suite tripwire: `npm test` must not write under the developer's real home.
// `pretest` runs `snapshot`, `posttest` runs `check` (exit 1 on any change). Watched: ~/.uxopian,
// its f2-tokens/ and targets.json, under both the login home (os.userInfo, immune to a HOME
// override) and $HOME. A real uxc used in another terminal DURING the run would trip it too.
import { existsSync, statSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import os from 'node:os';

const homes = [...new Set([os.userInfo().homedir, os.homedir()])];
const paths = homes.flatMap((h) => [join(h, '.uxopian'), join(h, '.uxopian', 'f2-tokens'), join(h, '.uxopian', 'targets.json')]);
const state = join(os.tmpdir(), `uxc-home-tripwire-${createHash('sha1').update(process.cwd()).digest('hex').slice(0, 12)}.json`);
const snapshot = () => Object.fromEntries(paths.map((p) => [p, existsSync(p) ? statSync(p).mtimeMs : null]));

const mode = process.argv[2];
if (mode === 'snapshot') {
  writeFileSync(state, JSON.stringify(snapshot()));
} else if (mode === 'check') {
  let before;
  try { before = JSON.parse(readFileSync(state, 'utf8')); } catch {
    console.error('home tripwire: no snapshot (run through `npm test`)');
    process.exit(0);
  }
  rmSync(state, { force: true });
  const now = snapshot();
  const changed = paths.filter((p) => before[p] !== now[p]);
  if (changed.length) {
    console.error(`home tripwire: the test run touched the real home:\n${changed.map((p) => `  ${p}: ${before[p] === null ? 'absent' : 'mtime ' + before[p]} -> ${now[p] === null ? 'absent' : 'mtime ' + now[p]}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`home tripwire: real home untouched (${homes.join(', ')})`);
} else {
  console.error('usage: node scripts/home-tripwire.mjs snapshot|check');
  process.exit(2);
}
