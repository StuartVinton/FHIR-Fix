// server.js
// ---------------------------------------------------------------------------
// Entry point. Loads .env, creates the Moleculer broker, registers services.
// ---------------------------------------------------------------------------

import { readFileSync, existsSync } from 'fs';
import { ServiceBroker } from 'moleculer';
import { settings } from './config/settings.js';
import FixService from './services/fix.service.js';
import GatewayService from './services/gateway.service.js';

// ── Load .env manually (no external dependency needed) ───────────────────────
// Only load in development — Docker passes env vars directly.
if (existsSync('.env')) {
  const lines = readFileSync('.env', 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key   = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    // Only set if not already set by the environment (Docker env vars take priority)
    if (!process.env[key]) process.env[key] = value;
  }
}

// ── Create broker and register services ──────────────────────────────────────
const broker = new ServiceBroker({
  nodeID: 'fhir-fix',
  logLevel: settings.logLevel,
  logger: true,
});

broker.createService(FixService);
broker.createService(GatewayService);

// ── Start ─────────────────────────────────────────────────────────────────────
broker.start().then(() => {
  broker.logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  broker.logger.info('  FHIR Fix Service');
  broker.logger.info(`  UI         : http://localhost:${settings.listenPort}`);
  broker.logger.info(`  Fix API    : http://localhost:${settings.listenPort}${settings.fhirBasePath}/:resourceType/$fix`);
  broker.logger.info(`  Upstream   : ${settings.upstreamUrl}`);
  broker.logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});
