// services/upstream.js
// ---------------------------------------------------------------------------
// Shared fetch helper for all calls to the upstream FHIR server.
//
// Handles two cross-cutting concerns so neither fix.service.js nor
// gateway.service.js need to repeat this logic:
//
//   1. API key  — if settings.apiKey is set, injects it as the `apikey`
//                 header on every request.
//
//   2. TLS      — if the upstream uses HTTPS with a self-signed or
//                 internally-issued certificate, sets rejectUnauthorized:false
//                 on the undici Agent (equivalent to curl -k / --insecure).
//                 Only applied when UPSTREAM_URL starts with https:// AND
//                 TLS_REJECT_UNAUTHORIZED=false is set. Plain http:// upstreams
//                 are never affected.
// ---------------------------------------------------------------------------

import { Agent } from 'undici';
import { settings } from '../config/settings.js';

// Lazily-created Agent instance — reused across all requests
let _insecureAgent = null;

function getInsecureAgent() {
  if (!_insecureAgent) {
    _insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });
  }
  return _insecureAgent;
}

/**
 * Build fetch options for an upstream FHIR request.
 *
 * @param {object} overrides  - Optional overrides: { method, headers, body }
 * @returns {object}            Options object ready to pass to fetch()
 */
export function upstreamFetchOptions(overrides = {}) {
  const headers = {
    Accept: 'application/fhir+json, application/json',
    ...(overrides.headers ?? {}),
  };

  // Inject API key header only when one is configured
  if (settings.apiKey) {
    headers['apikey'] = settings.apiKey;
  }

  const opts = { headers };

  // Inject the insecure dispatcher only for HTTPS upstreams where the cert
  // check has been explicitly disabled via TLS_REJECT_UNAUTHORIZED=false
  const isHttps = settings.upstreamUrl.toLowerCase().startsWith('https://');
  if (isHttps && !settings.tlsRejectUnauthorized) {
    opts.dispatcher = getInsecureAgent();
  }

  if (overrides.method)  opts.method = overrides.method;
  if (overrides.body)    opts.body   = overrides.body;

  return opts;
}
