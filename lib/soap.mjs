// Minimal SOAP 1.1 client for the FlowerDocs Core web services (/core/services/*).
// Zero-dep: hand-built envelope + fetch + light response/fault extraction. The FlowerDocs scope
// messages are simple (no WS-Security, no MTOM on /scope), so a full SOAP stack is overkill.
//
// Auth + context travel as three SOAP headers in the (literal) namespace "flower", exactly as the
// CLM client's CXF interceptors inject them (see FD-SCOPE-SOAP.md):
//   <token xmlns="flower">JWT</token>  <scope xmlns="flower">CTX</scope>  <request xmlns="flower">id</request>
// The token is the same JWT uxc mints at POST /core/rest/authentication.
const ENV_NS = 'http://schemas.xmlsoap.org/soap/envelope/';
const SERVICE_ACTION_BASE = 'http://flower.com/service';

export class SoapFault extends Error {
  constructor({ faultstring, code, raw }, status) {
    super(`SOAP fault${code ? ` [${code}]` : ''}: ${faultstring || '(no faultstring)'}`);
    this.faultstring = faultstring;
    this.code = code;
    this.status = status;
    this.raw = raw;
  }
}

/** XML-escape a text node / attribute value. */
export const xmlEsc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export function buildEnvelope({ token, scope, request, bodyXml }) {
  const headers = [
    token != null ? `<token xmlns="flower">${xmlEsc(token)}</token>` : '',
    scope != null ? `<scope xmlns="flower">${xmlEsc(scope)}</scope>` : '',
    request != null ? `<request xmlns="flower">${xmlEsc(request)}</request>` : '',
  ].join('');
  return `<?xml version="1.0" encoding="UTF-8"?>`
    + `<soap:Envelope xmlns:soap="${ENV_NS}">`
    + `<soap:Header>${headers}</soap:Header>`
    + `<soap:Body>${bodyXml}</soap:Body>`
    + `</soap:Envelope>`;
}

/**
 * POST a SOAP request. `action` is the service-relative SOAPAction (e.g. "scope/create"),
 * expanded to "http://flower.com/service/scope/create". Returns the raw response XML string.
 * Throws SoapFault on a soap:Fault or a 4xx/5xx.
 */
export async function soapPost(url, { action, token, scope, request, bodyXml, timeout = 60_000 }) {
  const envelope = buildEnvelope({ token, scope, request, bodyXml });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=UTF-8', SOAPAction: `"${SERVICE_ACTION_BASE}/${action}"` },
    body: envelope,
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  if (/<(?:\w+:)?Fault[\s>]/.test(text)) throw new SoapFault(parseFault(text), res.status);
  if (res.status >= 400) throw new SoapFault({ faultstring: text.slice(0, 300), raw: text }, res.status);
  return text;
}

/** Pull faultstring + a FlowerDocs error code (F00xxx / T00xxx) out of a soap:Fault body. */
export function parseFault(xml) {
  const faultstring = firstTag(xml, 'faultstring') ?? firstTag(xml, 'Reason') ?? firstTag(xml, 'Text');
  const code = (xml.match(/\b([FT]\d{5})\b/) ?? [])[1] ?? null;
  return { faultstring: faultstring?.trim(), code, raw: xml };
}

/** First inner text of <[*:]name>…</…> (namespace-prefix-agnostic), or null. */
export function firstTag(xml, name) {
  const m = xml.match(new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'i'));
  return m ? m[1] : null;
}

/** All inner texts of <[*:]name>…</…> occurrences. */
export function allTags(xml, name) {
  const re = new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

/** Split a response into the inner XML of each <[*:]Scope>…</Scope> block. */
export function scopeBlocks(xml) {
  return allTags(xml, 'Scope');
}
