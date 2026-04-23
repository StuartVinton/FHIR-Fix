// services/gateway.service.js
// ---------------------------------------------------------------------------
// HTTP gateway. Opens the port, serves the web UI, and routes FHIR requests
// to fix.service.js via Moleculer actions.
//
// Routes:
//   GET  /                                          → web UI (public/index.html)
//   GET  /fhir/stu3/:resourceType/$fix?...          → fix.applyFix action
//   GET  /fhir/stu3/:resourceType/:id               → passthrough proxy to upstream
//   GET  /fhir/stu3/:resourceType?...               → passthrough proxy to upstream
//   GET  /api/fix-files                             → fix.listFixFiles action
//   GET  /api/health                                → health check
// ---------------------------------------------------------------------------

import ApiService from 'moleculer-web';
import { createReadStream, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { settings } from '../config/settings.js';
import { upstreamFetchOptions } from './upstream.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../public');

// ── Helpers ───────────────────────────────────────────────────────────────────

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body, null, 2));
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function serveFile(res, filePath) {
  if (!existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }
  const mime = {
    '.html': 'text/html',
    '.js':   'application/javascript',
    '.css':  'text/css',
    '.json': 'application/json',
    '.ico':  'image/x-icon',
  }[path.extname(filePath)] ?? 'application/octet-stream';
  res.setHeader('Content-Type', mime);
  createReadStream(filePath).pipe(res);
}

// Parse _fix, _count, and the remaining FHIR query from req.query
function parseQueryParams(query) {
  const fixFile   = query._fix   ?? '';
  const count     = parseInt(query._count ?? settings.defaultCount, 10);
  const fhirQuery = Object.entries(query)
    .filter(([k]) => k !== '_fix' && k !== '_count')
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  return { fixFile, count: isNaN(count) ? settings.defaultCount : count, fhirQuery };
}

// Proxy a plain GET request to the upstream FHIR server and pipe the response back.
// This is the core of RAW GET mode — the browser always talks to :8301, the
// server-side fetch to :8300 is unrestricted by CORS, and upstream.js injects
// the API key header and TLS settings automatically.
async function proxyToUpstream(req, res, upstreamPath) {
  const qs = Object.entries(req.query ?? {})
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');

  const targetUrl = `${settings.upstreamUrl}${upstreamPath}${qs ? '?' + qs : ''}`;

  try {
    const upstream = await fetch(targetUrl, upstreamFetchOptions());
    const body = await upstream.text();
    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('Content-Type') ?? 'application/fhir+json',
    });
    res.end(body);
  } catch (err) {
    sendError(res, 502, `Could not reach upstream: ${err.message}`);
  }
}

// ── Service ───────────────────────────────────────────────────────────────────

export default {
  name: 'gateway',
  mixins: [ApiService],

  settings: {
    port: settings.listenPort,
    routes: [

      // ── FHIR routes ──────────────────────────────────────────────────────
      // Order matters — $fix must be matched before the plain :resourceType
      // catch-all, so it is defined first in this route block.
      {
        path: settings.fhirBasePath,
        aliases: {

          // ── $fix action ─────────────────────────────────────────────────
          'GET /:resourceType/\\$fix': (req, res) => {
            const { resourceType } = req.$params;
            const { fixFile, count, fhirQuery } = parseQueryParams(req.query);

            if (!fixFile) {
              sendError(res, 400, 'Missing required query parameter: _fix (e.g. &_fix=Encounter_participant_fix)');
              return;
            }

            req.$ctx
              .call('fix.applyFix', { resourceType, fixFile, fhirQuery, count })
              .then(result => sendJson(res, 200, result))
              .catch(err   => sendError(res, err.code >= 400 ? err.code : 500, err.message));
          },

          // ── Passthrough: individual resource by id ───────────────────────
          // e.g. GET /fhir/stu3/Encounter/abc-123
          'GET /:resourceType/:id': (req, res) => {
            const { resourceType, id } = req.$params;
            proxyToUpstream(req, res, `${settings.fhirBasePath}/${resourceType}/${id}`);
          },

          // ── Passthrough: resource type search ────────────────────────────
          // e.g. GET /fhir/stu3/Encounter?status=finished&_count=10
          // This is what RAW GET mode hits when Base URL is set to :8301
          'GET /:resourceType': (req, res) => {
            const { resourceType } = req.$params;
            proxyToUpstream(req, res, `${settings.fhirBasePath}/${resourceType}`);
          },

        },
        bodyParsers: { json: false, urlencoded: false },
        cors: { origin: '*', methods: ['GET', 'OPTIONS'] },
        logging: true,
      },

      // ── Internal API for the UI ──────────────────────────────────────────
      {
        path: '/api',
        aliases: {
          // Returns list of available fix file names so the UI can populate a dropdown
          'GET /fix-files': (req, res) => {
            req.$ctx
              .call('fix.listFixFiles')
              .then(files => sendJson(res, 200, { files }))
              .catch(err  => sendError(res, 500, err.message));
          },

          // Health check — useful for confirming the active configuration
          'GET /health': (req, res) => {
            sendJson(res, 200, {
              status:               'ok',
              upstream:             settings.upstreamUrl,
              fhirBase:             settings.fhirBasePath,
              listenPort:           settings.listenPort,
              apiKeyConfigured:     !!settings.apiKey,
              tlsRejectUnauthorized: settings.tlsRejectUnauthorized,
            });
          },
        },
        bodyParsers: { json: false, urlencoded: false },
        cors: { origin: '*', methods: ['GET', 'OPTIONS'] },
        logging: false,
      },

      // ── Static files — serves public/ at / ──────────────────────────────
      {
        path: '/',
        aliases: {
          'GET /':       (req, res) => serveFile(res, path.join(PUBLIC_DIR, 'index.html')),
          'GET /:file':  (req, res) => serveFile(res, path.join(PUBLIC_DIR, req.$params.file)),
        },
        bodyParsers: { json: false, urlencoded: false },
        cors: { origin: '*', methods: ['GET', 'OPTIONS'] },
        logging: false,
      },
    ],

    onError(req, res, err) {
      sendError(res, err.code >= 400 ? err.code : 500, err.message ?? 'Unexpected error');
    },
  },
};
