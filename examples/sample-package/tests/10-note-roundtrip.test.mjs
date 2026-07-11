// Minimal embedded functional test (the format reference — see DESIGN §24 / `uxc test`).
// Proves the deployed customization on a LIVE target: the shipped class accepts a document
// carrying the shipped tag, and the fixture reads back. Fixtures are ZZTEST_-namespaced and
// deleted at teardown automatically.
export default {
  name: 'note round-trip',
  description: 'a ZZTEST note of the shipped class, carrying the shipped tag, reads back',
  requires: {
    // unmet => SKIP with the reason (e.g. the package is not installed on this target)
    resources: ['fd.documentclass/SpNote', 'fd.tagclass/SpStatus'],
  },
  timeoutMs: 60_000,
  async run(t) {
    const doc = await t.doc.create({
      classId: 'SpNote',
      tags: { SpStatus: 'DRAFT' },              // {Tag: value} — or pass a ready-made tags array
      // file: 'fixtures/example.txt',          // optional content (path relative to tests/)
      // acl: 'ACL_ENV_Document',               // set when the target's class requires one
    });
    const echo = await t.core.getDoc(doc.id);
    t.expect(echo, `fixture ${doc.id} not readable back`);
    const status = (echo.tags ?? []).find((x) => x.name === 'SpStatus')?.value?.[0];
    t.expect(status === 'DRAFT', `SpStatus echo=${status}`);
    t.log(`note ${doc.id} round-tripped`);
  },
};
