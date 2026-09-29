// Where uxc keeps everything that is NOT a package: ~/.uxopian/{targets.json,marketplace.json,locks/}.
//
// This exists because `os.homedir()` is not the same knob on every platform, and the test suite
// relied on it being one. On POSIX it reads $HOME; on Windows it reads %USERPROFILE% and ignores
// $HOME entirely. Every test that isolated itself by setting `process.env.HOME` therefore ran
// UNISOLATED on Windows and wrote into the developer's real home — `~/.uxopian/locks/` filled with
// fixture locks and, worse, a fixture `targets.json` OVERWROTE the operator's real one, taking the
// credentials of every registered instance with it (reported on a first Windows run, #71).
//
// So the home used by uxc is resolved through ONE function, with an explicit override that works
// the same everywhere:
//   UXC_HOME  — absolute path; when set it wins on every platform (tests, CI, sandboxes, a shared
//               workstation that wants uxc config off the roaming profile)
// and only then falls back to os.homedir(). Tests set UXC_HOME; nothing else needs to know the
// platform rules.
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The home directory uxc reads and writes under. UXC_HOME overrides it on every platform. */
export function uxcHome() {
  const override = process.env.UXC_HOME;
  return override && override.trim() ? override : homedir();
}

/** `<home>/.uxopian/<...parts>` — resolved per call, so a test that moves UXC_HOME is obeyed. */
export function uxcDir(...parts) {
  return join(uxcHome(), '.uxopian', ...parts);
}
