// fd.workflow — read paths only. Write path is PDF-only (p.984), no recorded Zz* round-trip:
// ships read-only/external until one lands in FLOWERDOCS-LEARNINGS (DESIGN §7 #7).
import { classKindAdapter } from './base.mjs';

const adapter = classKindAdapter({
  kind: 'fd.workflow',
  dir: 'fd/workflows',
  restPath: 'workflow',
  defaultPolicy: 'external',
});

const readOnly = () => {
  throw new Error('fd.workflow is read-only in v1 (write path unverified) — see DESIGN §7');
};
adapter.create = readOnly;
adapter.update = readOnly;
adapter.remove = readOnly;

export default adapter;
