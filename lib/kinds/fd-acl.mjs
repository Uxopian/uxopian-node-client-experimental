// fd.acl — read paths only. Write path is PDF-only (p.979), no recorded Zz* round-trip:
// ships read-only/external in v1 (DESIGN §7 #8).
import { classKindAdapter } from './base.mjs';

const adapter = classKindAdapter({
  kind: 'fd.acl',
  dir: 'fd/acls',
  restPath: 'acl',
  defaultPolicy: 'external',
});

const readOnly = () => {
  throw new Error('fd.acl is read-only in v1 (write path unverified) — see DESIGN §7');
};
adapter.create = readOnly;
adapter.update = readOnly;
adapter.remove = readOnly;

export default adapter;
