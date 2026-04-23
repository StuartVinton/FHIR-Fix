// services/fix.service.js
// ---------------------------------------------------------------------------
// Core fix service. For a given resourceType and FHIR query:
//   1. Fetches a bundle from the upstream FHIR server
//   2. Loads a fix rule file from /fixes/
//   3. Applies the rules to every resource in the bundle
//   4. PUTs each corrected resource back to upstream
//   5. Returns a structured summary of what was updated
//
// Called by gateway.service.js via Moleculer action: fix.applyFix
//
// Example request that triggers this:
//   GET /fhir/stu3/Encounter/$fix?participant:missing=true&_fix=Encounter_participant_fix&_count=10
// ---------------------------------------------------------------------------

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { settings } from '../config/settings.js';
import { upstreamFetchOptions } from './upstream.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const FIXES_DIR  = path.resolve(__dirname, '../fixes');

export default {
  name: 'fix',

  actions: {

    // ── List available fix files ────────────────────────────────────────────
    listFixFiles: {
      async handler() {
        try {
          const files = await fs.readdir(FIXES_DIR);
          return files
            .filter(f => f.endsWith('.json'))
            .map(f => f.replace('.json', ''));
        } catch {
          return [];
        }
      },
    },

    // ── Main fix action ─────────────────────────────────────────────────────
    applyFix: {
      params: {
        resourceType: { type: 'string' },
        fixFile:      { type: 'string' },
        fhirQuery:    { type: 'string', optional: true, default: '' },
        count:        { type: 'number', optional: true, default: settings.defaultCount },
      },
      async handler(ctx) {
        const { resourceType, fixFile, fhirQuery, count } = ctx.params;

        // ── 1. Load fix rules ───────────────────────────────────────────────
        const fixFilePath = path.join(FIXES_DIR, `${fixFile}.json`);
        let fixRules;
        try {
          fixRules = JSON.parse(await fs.readFile(fixFilePath, 'utf-8'));
        } catch {
          const err = new Error(`Fix file "${fixFile}.json" not found in /fixes/`);
          err.code = 400;
          throw err;
        }

        // ── 2. Build upstream URL ───────────────────────────────────────────
        // Preserve FHIR modifier syntax (colons in keys like participant:missing
        // must NOT be percent-encoded — URLSearchParams would break them)
        const queryParts = [`_count=${count}`];
        if (fhirQuery.trim()) {
          for (const part of fhirQuery.split('&')) {
            const eqIdx = part.indexOf('=');
            if (eqIdx === -1) {
              queryParts.push(part.trim());
            } else {
              const k = part.slice(0, eqIdx).trim();
              const v = part.slice(eqIdx + 1).trim();
              queryParts.push(`${k}=${encodeURIComponent(v)}`);
            }
          }
        }

        const upstreamBase = `${settings.upstreamUrl}${settings.fhirBasePath}/${resourceType}`;
        const fetchUrl     = `${upstreamBase}?${queryParts.join('&')}`;

        this.logger.info(`[fix] GET ${fetchUrl}`);

        // ── 3. Fetch bundle ─────────────────────────────────────────────────
        let bundle;
        try {
          const resp = await fetch(fetchUrl, upstreamFetchOptions());
          if (!resp.ok) {
            const body = await resp.text();
            const err  = new Error(`Upstream returned HTTP ${resp.status}: ${body}`);
            err.code   = resp.status;
            throw err;
          }
          bundle = await resp.json();
        } catch (err) {
          if (err.code) throw err;
          const fetchErr = new Error(`Could not reach upstream server: ${err.message}`);
          fetchErr.code  = 502;
          throw fetchErr;
        }

        if (bundle.resourceType !== 'Bundle') {
          const err = new Error(`Expected a Bundle but upstream returned: ${bundle.resourceType}`);
          err.code  = 500;
          throw err;
        }

        const entries = bundle.entry ?? [];
        this.logger.info(
          `[fix] Bundle total=${bundle.total ?? '?'} fetched=${entries.length} fix=${fixFile}`
        );

        if (entries.length === 0) {
          return buildSummary(resourceType, fixFile, bundle.total ?? 0, count, [], [], [], fhirQuery);
        }

        // ── 4. Apply rules — only PUT if the resource actually changed ────────
        const succeeded = [];
        const skipped   = [];
        const failed    = [];

        for (const entry of entries) {
          const resource = entry.resource;
          if (!resource)      { this.logger.warn('[fix] Entry has no resource — skipping'); continue; }
          if (!resource.id)   { failed.push({ id: '(no id)', reason: 'Resource missing id field' }); continue; }

          // Apply every rule in sequence
          let fixed = structuredClone(resource);
          for (const rule of fixRules.rules ?? []) {
            fixed = applyRule(fixed, rule, this.logger);
          }

          // Compare before and after — skip PUT if nothing changed
          const changed = JSON.stringify(fixed) !== JSON.stringify(resource);
          if (!changed) {
            skipped.push({ id: resource.id, reason: 'No change needed — rules did not modify this resource' });
            this.logger.info(`[fix]  ⟳ ${resource.id} — no change, skipping PUT`);
            continue;
          }

          // PUT back only if something actually changed
          const putUrl = `${settings.upstreamUrl}${settings.fhirBasePath}/${resourceType}/${resource.id}`;
          this.logger.info(`[fix] PUT ${putUrl}`);

          try {
            const putResp = await fetch(putUrl, upstreamFetchOptions({
              method: 'PUT',
              headers: { 'Content-Type': 'application/fhir+json' },
              body:   JSON.stringify(fixed),
            }));

            if (putResp.ok) {
              succeeded.push({ id: resource.id, status: putResp.status });
              this.logger.info(`[fix]  ✓ ${resource.id} → ${putResp.status}`);
            } else {
              const errBody = await putResp.text();
              failed.push({ id: resource.id, reason: `HTTP ${putResp.status}: ${errBody}` });
              this.logger.error(`[fix]  ✗ ${resource.id} → ${putResp.status}`);
            }
          } catch (err) {
            failed.push({ id: resource.id, reason: err.message });
            this.logger.error(`[fix]  ✗ ${resource.id} → ${err.message}`);
          }
        }

        this.logger.info(`[fix] Done — succeeded:${succeeded.length} skipped:${skipped.length} failed:${failed.length}`);
        return buildSummary(resourceType, fixFile, bundle.total ?? entries.length, count, succeeded, skipped, failed, fhirQuery);
      },
    },
  },
};

// ── Summary builder ───────────────────────────────────────────────────────────

function buildSummary(resourceType, fixFile, bundleTotal, batchSize, succeeded, skipped, failed, fhirQuery) {
  const hasFilter = fhirQuery && fhirQuery.trim().length > 0;
  const remaining = hasFilter
    ? Math.max(0, (bundleTotal ?? 0) - succeeded.length - failed.length)
    : null;

  const totalActioned = succeeded.length + skipped.length + failed.length;
  let message;
  if (succeeded.length === 0 && skipped.length > 0 && failed.length === 0) {
    message = `No changes needed — all ${skipped.length} resource(s) already had the fix applied.`;
  } else if (failed.length === 0) {
    message = `${succeeded.length} resource(s) updated, ${skipped.length} already correct.`;
  } else {
    message = `${succeeded.length} updated, ${skipped.length} skipped (no change needed), ${failed.length} failed.`;
  }

  return {
    resourceType,
    fixFile,
    fhirQuery:    fhirQuery || null,
    hasFilter,
    bundleTotal:  bundleTotal ?? 0,
    batchSize,
    processed:    totalActioned,
    succeeded:    succeeded.length,
    skipped:      skipped.length,
    failed:       failed.length,
    remaining,
    message,
    succeededIds: succeeded,
    skippedIds:   skipped,
    failures:     failed,
  };
}

// ── Fix rule engine ───────────────────────────────────────────────────────────

function applyRule(resource, rule, logger) {
  const { type, path: fieldPath, ...rest } = rule;
  switch (type) {
    case 'value_map':       return applyValueMap(resource, fieldPath, rest.map);
    case 'set_value':       return setNested(resource, fieldPath, rest.value);
    case 'add_if_missing':  return addIfMissing(resource, fieldPath, rest.value);
    case 'append_to_array': return appendToArray(resource, fieldPath, rest.value, rest.skipIf);
    case 'delete_field':    return deleteNested(resource, fieldPath);
    case 'regex_replace':   return regexReplace(resource, fieldPath, rest.pattern, rest.replacement);
    default:
      logger.warn(`[fix] Unknown rule type "${type}" — skipping`);
      return resource;
  }
}

function getNested(obj, fieldPath) {
  return fieldPath.split('.').reduce((acc, k) => acc?.[k], obj);
}

function setNested(obj, fieldPath, value) {
  const keys   = fieldPath.split('.');
  const result = structuredClone(obj);
  let   cur    = result;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] === undefined) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
  return result;
}

function deleteNested(obj, fieldPath) {
  const keys   = fieldPath.split('.');
  const result = structuredClone(obj);
  let   cur    = result;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] === undefined) return result;
    cur = cur[keys[i]];
  }
  delete cur[keys[keys.length - 1]];
  return result;
}

function applyValueMap(obj, fieldPath, map) {
  const current     = getNested(obj, fieldPath);
  if (current === undefined) return obj;
  const replacement = map[current];
  if (replacement === undefined) return obj;
  return setNested(obj, fieldPath, replacement);
}

function addIfMissing(obj, fieldPath, value) {
  const current = getNested(obj, fieldPath);
  if (current !== undefined && current !== null) return obj;
  return setNested(obj, fieldPath, value);
}

function appendToArray(obj, fieldPath, value, skipIf) {
  const current      = getNested(obj, fieldPath);
  const currentArray = Array.isArray(current) ? current : [];

  if (skipIf && typeof skipIf === 'object') {
    const alreadyPresent = currentArray.some(element =>
      Object.entries(skipIf).every(([checkPath, checkValue]) => {
        const actual = checkPath.split('.').reduce((acc, key) => {
          const match = key.match(/^(.+)\[(\d+)\]$/);
          if (match) return acc?.[match[1]]?.[parseInt(match[2], 10)];
          return acc?.[key];
        }, element);
        return actual === checkValue;
      })
    );
    if (alreadyPresent) return obj;
  }

  return setNested(obj, fieldPath, [...currentArray, value]);
}

function regexReplace(obj, fieldPath, pattern, replacement) {
  const current = getNested(obj, fieldPath);
  if (typeof current !== 'string') return obj;
  return setNested(obj, fieldPath, current.replace(new RegExp(pattern, 'g'), replacement));
}
