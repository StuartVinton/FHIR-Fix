# FHIR Fix Console

A lightweight, self-hosted web tool for identifying and correcting data quality issues in a FHIR STU3 server. It runs as a small Node.js service, ships as a Docker container, and exposes a browser-based console for running bulk fixes or inspecting raw FHIR data.

---

## Table of Contents

- [What it does](#what-it-does)
- [Architecture](#architecture)
- [Quick start (Docker)](#quick-start-docker)
- [Configuration](#configuration)
- [The `.env` file](#the-env-file)
- [HTTPS upstreams and self-signed certificates](#https-upstreams-and-self-signed-certificates)
- [API key authentication](#api-key-authentication)
- [Using the console](#using-the-console)
  - [$FIX mode](#fix-mode)
  - [RAW GET mode](#raw-get-mode)
- [Fix files](#fix-files)
  - [File format](#file-format)
  - [Rule types](#rule-types)
  - [Writing a new fix](#writing-a-new-fix)
- [Project structure](#project-structure)
- [Docker volumes](#docker-volumes)
- [Health check](#health-check)

---

## What it does

FHIR stores can accumulate data quality problems over time — missing fields, incorrect codes, incomplete references. Fixing them by hand or with one-off scripts is slow and hard to repeat.

This tool lets you:

1. Define a **fix** as a small JSON rule file describing what to change on a FHIR resource.
2. Point the console at a resource type and an optional FHIR query filter to scope which records are affected.
3. Execute the fix — the service fetches matching resources, applies the rules, and PUTs only the records that actually changed back to the server.
4. Review a structured summary showing what was updated, what was already correct, and anything that failed.

All communication with the upstream FHIR server happens server-side, so there are no browser CORS issues regardless of how the upstream is configured.

---

## Architecture

```
Browser (localhost:8301)
        │
        ▼
┌───────────────────┐
│  gateway.service  │   Serves the UI, routes $fix calls, proxies raw GETs
│   (port 8301)     │
└────────┬──────────┘
         │  server-side fetch (API key + TLS handled here)
         ▼
┌───────────────────┐
│  fix.service      │   Loads fix JSON, applies rules, PUTs changed resources
└────────┬──────────┘
         │
         ▼
  Upstream FHIR server
  (e.g. https://localhost:8300)
```

The browser only ever talks to port **8301**. Port **8300** (or whatever your upstream is) is never contacted directly from the browser, which means CORS is not a concern.

---

## Quick start (Docker)

```bash
# 1. Pull the image
docker pull your-registry/fhir-fix-console:latest

# 2. Create your local config and fixes directories
mkdir -p /opt/fhir-fix/config /opt/fhir-fix/fixes

# 3. Copy and edit the environment file
cp .env.example /opt/fhir-fix/config/.env
nano /opt/fhir-fix/config/.env

# 4. Copy any fix JSON files you want to use
cp fixes/*.json /opt/fhir-fix/fixes/

# 5. Run
docker run -d \
  --name fhir-fix \
  -p 8301:8301 \
  -v /opt/fhir-fix/config/.env:/app/.env:ro \
  -v /opt/fhir-fix/fixes:/app/fixes:ro \
  your-registry/fhir-fix-console:latest
```

Open **http://localhost:8301** in your browser.

### docker-compose

```yaml
version: "3.8"
services:
  fhir-fix:
    image: your-registry/fhir-fix-console:latest
    ports:
      - "8301:8301"
    volumes:
      - ./config/.env:/app/.env:ro
      - ./fixes:/app/fixes:ro
    restart: unless-stopped
```

---

## Configuration

All configuration is driven by environment variables. The simplest way to set them is via the `.env` file in the project root, which is loaded automatically at startup.

| Variable                  | Default                  | Description |
|---------------------------|--------------------------|-------------|
| `LISTEN_PORT`             | `8301`                   | Port the console listens on |
| `UPSTREAM_URL`            | `http://localhost:8300`  | Base URL of the upstream FHIR server. Supports `http://` and `https://` |
| `FHIR_BASE_PATH`          | `/fhir/stu3`             | FHIR base path appended to both the listener and the upstream |
| `API_KEY`                 | _(empty — disabled)_     | API key sent as the `apikey` header on every upstream request. Leave unset if not required |
| `TLS_REJECT_UNAUTHORIZED` | `true`                   | Set to `false` to accept self-signed or internally-issued HTTPS certificates (equivalent to `curl -k`) |
| `LOG_LEVEL`               | `info`                   | Moleculer log level: `trace`, `debug`, `info`, `warn`, `error` |

---

## The `.env` file

```dotenv
# ── Listener ────────────────────────────────────────────────────────────────
LISTEN_PORT=8301

# ── Upstream FHIR server ─────────────────────────────────────────────────────
# Plain HTTP (default):
UPSTREAM_URL=http://localhost:8300

# HTTPS with a valid certificate:
# UPSTREAM_URL=https://fhir.internal.example.com:8443

# HTTPS with a self-signed certificate (also set TLS_REJECT_UNAUTHORIZED=false):
# UPSTREAM_URL=https://localhost:8300

FHIR_BASE_PATH=/fhir/stu3

# ── Authentication ───────────────────────────────────────────────────────────
# Leave commented out if the upstream does not require an API key
# API_KEY=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

# ── TLS ──────────────────────────────────────────────────────────────────────
# Set to false ONLY for HTTPS upstreams with self-signed certs in trusted
# internal environments. Has no effect when UPSTREAM_URL uses http://.
# TLS_REJECT_UNAUTHORIZED=false

# ── Logging ──────────────────────────────────────────────────────────────────
LOG_LEVEL=info
```

---

## HTTPS upstreams and self-signed certificates

Many on-premise FHIR servers listen on HTTPS but use a self-signed or internally-issued certificate that is not in the system trust store. This is the equivalent of passing `-k` or `--insecure` to curl.

To enable this:

```dotenv
UPSTREAM_URL=https://localhost:8300
TLS_REJECT_UNAUTHORIZED=false
```

The `TLS_REJECT_UNAUTHORIZED=false` setting only applies to connections from this service to the upstream. It has no effect on plain `http://` upstreams and does not affect anything else on the host.

> **Note:** Only use this in controlled, trusted network environments. If the upstream has a valid certificate, leave `TLS_REJECT_UNAUTHORIZED` at its default (`true`).

---

## API key authentication

If the upstream FHIR server requires an API key, set:

```dotenv
API_KEY=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

The key is sent as the `apikey` request header on every GET and PUT made to the upstream — including raw proxy GETs from RAW GET mode and all fix operations. If `API_KEY` is not set or is empty, the header is not sent at all.

---

## Using the console

Open **http://localhost:8301** in your browser. The sidebar has two sections: **SERVER** (connection settings) and **MODE** (what operation to run).

The **Base URL** field in the UI should always be set to `http://localhost:8301` (or wherever this service is running). It is **not** the upstream FHIR server address — that is configured in `.env`.

### $FIX mode

Use this to apply a fix rule file to a set of resources.

| Field | Description |
|---|---|
| Resource Type | The FHIR resource to operate on, e.g. `Encounter` |
| Fix File | Which JSON rule file from `/fixes/` to apply |
| FHIR Query Filter | Optional FHIR search parameters to scope which resources are fetched, e.g. `participant-type:not=PPRF` |
| Count (`_count`) | How many resources to process per run. Defaults to 100 |

The response panel shows:
- **Total in bundle** — how many resources matched the filter on the server
- **Updated** — resources that were changed and successfully PUT
- **No change** — resources that were fetched but the rules found nothing to modify
- **Failed** — resources where the PUT was rejected or errored
- **Remaining** — estimated resources still needing the fix (only shown when a filter is active)

If there are more resources than your batch size, run again — the filter will continue returning unprocessed records until all are done.

### RAW GET mode

Use this to inspect FHIR data directly without applying any fix. Useful for verifying a query before running a fix, or for checking what a resource looks like before and after.

Enter a FHIR path in the **URL or Path** field, e.g.:

```
/fhir/stu3/Encounter?_count=5&status=finished
/fhir/stu3/Patient/abc-123
/fhir/stu3/Encounter?participant-type:not=PPRF&_count=10
```

The request is proxied server-side through this service, so the upstream's lack of CORS headers is not a problem. The API key and TLS settings from `.env` are applied automatically.

The **Quick Examples** buttons populate common queries to get started quickly.

---

## Fix files

Fix files live in the `/fixes/` directory and are loaded at runtime. In Docker, this directory is a volume so you can add or update files without rebuilding the image.

### File format

```json
{
  "_description": "Human-readable description of what this fix does",
  "_resourceType": "Encounter",
  "_field": "participant",
  "rules": [
    {
      "type": "<rule type>",
      "path": "dot.notation.field.path",
      ... rule-specific options ...
    }
  ]
}
```

The `_description`, `_resourceType`, and `_field` keys are informational only and are not used by the engine. The `rules` array is processed in order — each rule receives the output of the previous one.

### Rule types

#### `set_value`
Unconditionally sets a field to a value.
```json
{
  "type": "set_value",
  "path": "status",
  "value": "finished"
}
```

#### `add_if_missing`
Sets a field only if it is currently absent or null.
```json
{
  "type": "add_if_missing",
  "path": "language",
  "value": "en"
}
```

#### `value_map`
Replaces a field's value using a lookup table. Unmatched values are left unchanged.
```json
{
  "type": "value_map",
  "path": "status",
  "map": {
    "in-progress": "finished",
    "planned": "cancelled"
  }
}
```

#### `append_to_array`
Appends an object to an array field. The optional `skipIf` guard prevents duplicates — if any existing array element matches the given path/value check, the append is skipped.
```json
{
  "type": "append_to_array",
  "path": "participant",
  "skipIf": {
    "type[0].coding[0].code": "PPRF"
  },
  "value": {
    "type": [{ "coding": [{ "code": "PPRF", "display": "primary performer" }] }],
    "individual": { "reference": "Practitioner/example" }
  }
}
```

#### `delete_field`
Removes a field entirely.
```json
{
  "type": "delete_field",
  "path": "extension"
}
```

#### `regex_replace`
Runs a find/replace on a string field using a regular expression.
```json
{
  "type": "regex_replace",
  "path": "subject.reference",
  "pattern": "^Patient/",
  "replacement": "patient/"
}
```

### Writing a new fix

1. Create a new `.json` file in the `/fixes/` directory following the format above.
2. Name it descriptively, e.g. `Encounter_missing_status_fix.json`.
3. The filename (without `.json`) is what you select in the Fix File dropdown.
4. Test with a small `_count` (e.g. 1 or 5) and use **RAW GET mode** to verify the data before and after.
5. Once satisfied, run with a larger count until **Remaining** reaches 0.

No restart is required — fix files are read from disk on every execution.

---

## Project structure

```
C:\fhir-fix\
├── server.js                  # Entry point — loads .env, starts Moleculer broker
├── package.json
├── .env                       # Local configuration (not committed to source control)
├── .env.example               # Template — copy to .env and edit
├── config\
│   └── settings.js            # Reads env vars, exports settings object
├── services\
│   ├── upstream.js            # Shared fetch helper: API key + TLS injection
│   ├── fix.service.js         # Fix engine: fetch → apply rules → PUT
│   └── gateway.service.js     # HTTP gateway: UI, $fix route, raw proxy
├── fixes\                     # ← Volume in Docker
│   ├── Encounter_participant_fix.json
│   ├── Encounter_participant_pprf_fix.json
│   └── AllergyIntolerance_criticality_fix.json
└── public\
    └── index.html             # Web console UI
```

---

## Docker volumes

Two paths should be mounted as volumes when running in Docker:

| Container path | Purpose |
|---|---|
| `/app/.env` | Environment configuration — upstream URL, API key, TLS settings |
| `/app/fixes` | Fix JSON files — add new fixes here without rebuilding the image |

Example:
```bash
-v /opt/fhir-fix/.env:/app/.env:ro
-v /opt/fhir-fix/fixes:/app/fixes:ro
```

Both are mounted read-only (`:ro`) since the service never writes to them.

---

## Health check

```
GET http://localhost:8301/api/health
```

Returns the active configuration so you can confirm the service has picked up the right settings:

```json
{
  "status": "ok",
  "upstream": "https://localhost:8300",
  "fhirBase": "/fhir/stu3",
  "listenPort": 8301,
  "apiKeyConfigured": true,
  "tlsRejectUnauthorized": false
}
```

Note that the API key value is never returned — only whether one is configured.
