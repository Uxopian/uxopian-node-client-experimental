// Public library surface (DESIGN §15). Sibling repos import this instead of re-growing ad-hoc
// http() helpers:
//   import { connect, openPackage, KINDS, runPrompt } from 'uxopian-client';
//   const ux = await connect('iris');                       // { core, gateway, gui, cacheClear, target }
//   await ux.core.search({ classId: 'CtContract', where: { CtReviewStatus: 'BLOCKED' } });
//   await ux.gateway.post('/api/v1/conversations', {});
//   const pkg = openPackage('.');                            // registry + state access
import { resolveTarget } from './config.mjs';
import { createClients } from './http.mjs';

/** Resolve a target (name > UXC_TARGET > default) and return authenticated API surfaces. */
export async function connect(targetName) {
  const t = resolveTarget(targetName);
  return { ...createClients(t), target: t };
}

export { openPackage } from './registry.mjs';
export { KINDS, PUSH_ORDER } from './kinds/index.mjs';
export { createMarketplaceClient, MarketplaceError, contentTypeFor } from './marketplace.mjs';
export { resolveMarketplace, loadMarketplace, saveMarketplace } from './mpconfig.mjs';
export { buildCatalog, readMarketplaceManifest, validateMarketplace, scaffoldMarketplace } from './catalog.mjs';
export { createScopeClient, blankScopeXml, retargetScopeXml } from './scope.mjs';
export { soapPost, buildEnvelope, SoapFault } from './soap.mjs';
export { canonicalize, hashResource } from './canonical.mjs';
export { runPrompt } from './run.mjs';
export { explainCode, explainError } from './explain.mjs';
export * as naming from './naming.mjs';
export * as util from './util.mjs';
