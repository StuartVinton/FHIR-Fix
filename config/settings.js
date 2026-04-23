// config/settings.js
// ---------------------------------------------------------------------------
// Single source of truth for all configuration.
// Values are read from environment variables, which are loaded from .env
// by server.js before this module is imported.
//
// To change settings locally:  edit .env
// To change settings in Docker: pass -e flags or set in docker-compose.yml
// ---------------------------------------------------------------------------

export const settings = {
  // Port this service listens on
  listenPort: parseInt(process.env.LISTEN_PORT ?? '8301', 10),

  // Upstream FHIR STU3 server — all GETs and PUTs go here.
  // Supports both http:// and https:// schemes.
  // Examples:
  //   UPSTREAM_URL=http://localhost:8300
  //   UPSTREAM_URL=https://localhost:8300
  //   UPSTREAM_URL=https://fhir.client-server.local:8443
  upstreamUrl: process.env.UPSTREAM_URL ?? 'http://localhost:8300',

  // FHIR base path appended to both the listener and upstream URLs
  fhirBasePath: process.env.FHIR_BASE_PATH ?? '/fhir/stu3',

  // API key sent as the `apikey` request header on every upstream call.
  // Leave unset (or empty) if the upstream does not require authentication.
  // Example:  API_KEY=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  apiKey: process.env.API_KEY ?? '',

  // When the upstream uses HTTPS with a self-signed or internally-issued
  // certificate, set this to false to skip certificate verification.
  // Equivalent to curl -k / --insecure.
  // WARNING: only disable in controlled, trusted network environments.
  // Default: true (verification enabled — safe for production)
  tlsRejectUnauthorized: (process.env.TLS_REJECT_UNAUTHORIZED ?? 'true') !== 'false',

  // Moleculer log level
  logLevel: process.env.LOG_LEVEL ?? 'info',

  // Default _count if caller doesn't supply one
  defaultCount: 100,
};
