// uxc install-claude — symlink the repo's Claude integration into ~/.claude/:
//   claude/skills/<name>/  -> ~/.claude/skills/<name>
//   claude/commands/*.md   -> ~/.claude/commands/<file>
// Existing SYMLINKS are replaced (re-install = refresh); real files/dirs are never overwritten.
import { existsSync, lstatSync, mkdirSync, readdirSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// this module lives at <repo>/lib/commands/install-claude.mjs
const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export default {
  name: 'install-claude',
  summary: 'symlink the uxopian-client Claude skill + slash commands into ~/.claude',
  help: 'uxc install-claude',
  async run(ctx) {
    const links = [];
    const link = (src, dest) => {
      let st = null;
      try { st = lstatSync(dest); } catch { /* absent */ }
      if (st) {
        if (!st.isSymbolicLink()) {
          ctx.out.warn(`${dest} exists and is NOT a symlink — left untouched (move it aside and re-run)`);
          return;
        }
        unlinkSync(dest); // refresh an existing symlink
      }
      symlinkSync(src, dest);
      links.push({ dest, src });
      ctx.out.line(`${dest} -> ${src}`);
    };

    const skillsSrc = join(REPO, 'claude', 'skills');
    if (existsSync(skillsSrc)) {
      const destDir = join(homedir(), '.claude', 'skills');
      mkdirSync(destDir, { recursive: true });
      for (const name of readdirSync(skillsSrc)) {
        const src = join(skillsSrc, name);
        if (statSync(src).isDirectory()) link(src, join(destDir, name));
      }
    }

    const cmdsSrc = join(REPO, 'claude', 'commands');
    if (existsSync(cmdsSrc)) {
      const destDir = join(homedir(), '.claude', 'commands');
      mkdirSync(destDir, { recursive: true });
      for (const name of readdirSync(cmdsSrc)) {
        if (name.endsWith('.md')) link(join(cmdsSrc, name), join(destDir, name));
      }
    }

    ctx.out.line(`${links.length} link(s) installed`);
    if (ctx.out.json) ctx.out.result(links);
  },
};
