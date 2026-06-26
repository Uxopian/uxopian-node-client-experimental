// uxc version — print the uxc client version (the value packages pin against via minClientVersion).
import { CLIENT_VERSION } from '../version.mjs';

export default {
  name: 'version',
  summary: 'print the uxc client version',
  help: 'uxc version   (also: uxc --version)',
  async run(ctx) {
    ctx.out.line(CLIENT_VERSION);
    ctx.out.result({ version: CLIENT_VERSION });
  },
};
