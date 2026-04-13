# Stats Dashboard — Full Development Log

> Live URL: **https://stats.viralpatelstudio.in**  
> Server: `root@68.183.81.164` (DigitalOcean, 1 vCPU / 1 GB RAM, Bangalore)  
> Stack: Angular 21 + Node.js/Express + Nginx + Let's Encrypt + Cloudflare DNS

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Infrastructure Setup](#2-infrastructure-setup)
3. [Backend API — server/index.js](#3-backend-api)
4. [Frontend — Angular 21 SPA](#4-frontend)
5. [Features Built](#5-features-built)
6. [Performance Optimizations](#6-performance-optimizations)
7. [UI/UX Improvements](#7-uiux-improvements)
8. [Dark Mode](#8-dark-mode)
9. [Bug Fixes & Production Incidents](#9-bug-fixes--production-incidents)
10. [All File Changes](#10-all-file-changes)
11. [Responsive Layout Reference](#11-responsive-layout-reference)
12. [Production State](#12-production-state)

---

## 1. Project Overview

A lightweight, real-time infrastructure observability dashboard for a personal cloud server. Built from scratch to provide a single public URL that shows:

- CPU, Memory, and Disk utilization
- Docker container status (running / stopped with per-container details)
- Database engine health (MySQL, PostgreSQL, MongoDB, Redis, etc.)
- Storage usage treemap (top-level directory breakdown via `du`)
- Website uptime checks (HTTP status + response latency for 9 domains)
- Global health badge (Healthy / Caution / Critical)
- Dark / Light theme toggle with system preference detection

---

## 2. Infrastructure Setup

### DNS & Nginx
- Subdomain `stats.viralpatelstudio.in` → A record → `68.183.81.164` (Cloudflare proxied)
- Nginx vhost created at `/etc/nginx/sites-available/stats.viralpatelstudio.in.conf`
- Proxies `/api/` requests to `http://127.0.0.1:3510` (local Express API)
- Serves Angular SPA static files from `/var/www/stats.viralpatelstudio.in/`

### TLS
- Certificate issued via `certbot --nginx` for `stats.viralpatelstudio.in`
- Certificate path: `/etc/letsencrypt/live/stats.viralpatelstudio.in/`
- Expiry: 2026-07-12, auto-renew via certbot systemd timer

### Backend Service
- Managed as systemd service: `stats-dashboard-api`
- Entry point: `/opt/stats-dashboard-api/index.js`
- Runs on `127.0.0.1:3510`
- Start/restart: `systemctl restart stats-dashboard-api`

---

## 3. Backend API

### File: `server/index.js` (deployed at `/opt/stats-dashboard-api/index.js`)

#### Dependencies
```
express, cors, helmet, node:os, node:child_process (promisified execFile)
```

#### Environment Variables
| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3510` | Server port |
| `HOST` | `127.0.0.1` | Bind address |
| `METRICS_CACHE_TTL_MS` | `30000` (30s) | Metrics cache lifetime |
| `STORAGE_TREE_CACHE_TTL_MS` | `600000` (10 min) | Storage tree cache lifetime |
| `WEBSITE_STATUS_CACHE_TTL_MS` | `300000` (5 min) | Website check cache lifetime |
| `WEBSITE_TARGETS` | 9 predefined domains | Comma-separated list of domains to probe |

#### Endpoints
- `GET /health` — Returns `{ ok: true, timestamp }`. Used for liveness checks.
- `GET /metrics?fresh=1` — Returns full metrics payload. `fresh=1` bypasses cache.

#### Metrics Payload Shape
```json
{
  "timestamp": "ISO string",
  "cpu": { "usagePercent": 0–100 },
  "memory": { "usagePercent": 0–100, "totalBytes": N, "usedBytes": N },
  "disk": { "mount": "/", "usagePercent": 0–100, "totalBytes": N, "usedBytes": N, "availableBytes": N },
  "docker": {
    "running": true,
    "runningCount": N,
    "stoppedCount": N,
    "totalCount": N,
    "containers": [{ "name": "", "state": "", "status": "", "image": "", "lastSeenAt": "" }]
  },
  "database": {
    "overall": "up|down|not-detected",
    "engines": [{ "name": "", "status": "", "source": "" }]
  },
  "storageTree": [{ "path": "", "sizeBytes": N, "ratio": 0–1 }],
  "websites": [{ "host": "", "status": "up|down", "httpCode": N, "responseMs": N, "checkedAt": "" }]
}
```

#### Key Functions

**`getMetricsWithCache(forceFresh)`**
- 30-second in-memory cache (`metricsCache.payload/expiresAt`)
- Concurrent request coalescing via `metricsInFlight` promise
- `forceFresh=true` bypasses cache and triggers immediate re-fetch

**`getStorageTreeMapCached()`**
- 10-minute cache
- Primary probe: `du -x -B1 -d 1 /` with 45-second timeout
- Timeout/error fallback: per-directory scan of a predefined list of top-level paths
- Returns array sorted by `sizeBytes` descending with `ratio` = `sizeBytes / totalSize`

**`getDockerStatus()`**
- Command: `docker ps -a --format '{{.Names}}\t{{.State}}\t{{.Status}}\t{{.Image}}'`
- Parses TSV into structured container objects
- Computes `runningCount`, `stoppedCount`, `totalCount`

**`getWebsiteStatusCached()`**
- 5-minute cache
- For each domain in `WEBSITE_TARGETS`: runs `curl -sk -o /dev/null -w "%{http_code}\t%{time_total}" https://{host}`
- Records `httpCode`, `responseMs`, `status` (`up` if 200–399, else `down`), `checkedAt`

**`safeExec(command, args, options)`**
- Wrapper around `execFileAsync` with default 12-second timeout
- Accepts per-call `timeoutMs` override
- Throws descriptive error on timeout or non-zero exit

**CPU Sampling — Critical Fix**
- CPU % is sampled **before** all other parallel probes
- Previously sampled in parallel with `du`, Docker, and website curl probes, causing self-inflated readings (always ~100%)
- Now isolated as the first serial operation → accurate readings of 0–5%

---

## 4. Frontend

### Stack
- **Angular 21.2** standalone component architecture
- **Angular Material v21** — Cards, Chips, ProgressBar, Spinner, Button
- **Zone.js `~0.15.1`** — explicitly imported in `main.ts`
- **RxJS** — `finalize` operator for loading state
- **Font**: Space Grotesk (Google Fonts via `styles.scss`)

### File Structure
```
src/
├── main.ts              — Bootstrap entry point (imports zone.js first)
├── index.html           — App shell
├── styles.scss          — Global styles + font import
└── app/
    ├── app.ts           — Root standalone component (all logic)
    ├── app.html         — Dashboard template
    ├── app.scss         — Component styles
    ├── app.config.ts    — Angular providers
    └── app.routes.ts    — Empty routes array
```

### `src/main.ts`
```ts
import 'zone.js';  // Must be first — required for Angular 21 (not bundled by default)
import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';

bootstrapApplication(App, appConfig).catch((err) => console.error(err));
```

### `src/app/app.config.ts`
```ts
providers: [
  provideZoneChangeDetection({ eventCoalescing: true }),  // Batch change detection events
  provideBrowserGlobalErrorListeners(),
  provideHttpClient(),
  provideRouter(routes)
]
```

### `src/app/app.ts` — Key Implementation Details

**Component decorator**
```ts
@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,  // Reduces unnecessary re-renders
  templateUrl: './app.html',
  styleUrl: './app.scss',
  imports: [NgFor, NgIf, NgClass, DecimalPipe, PercentPipe,
            MatButtonModule, MatCardModule, MatChipsModule,
            MatProgressBarModule, MatProgressSpinnerModule]
})
```

**Signals**
```ts
readonly title = signal('Stats Control Deck');
readonly loading = signal(false);
readonly error = signal<string | null>(null);
readonly metrics = signal<MetricsResponse | null>(null);
readonly lastUpdated = signal<Date | null>(null);
readonly isDarkMode = signal(false);
```

**`healthStatus` computed signal** (replaces repeated method calls — evaluated once per metrics update)
```ts
readonly healthStatus = computed(() => {
  // Counts critical conditions across CPU, Memory, Disk, Docker stopped, DB down, Websites down
  // Returns { color: string, text: string }
  // Critical (≥3 issues) → red  ● Critical
  // Caution  (1–2 issues) → amber  ● Caution
  // Healthy  (0 issues)  → green  ✓ Healthy
});
```

**Theme management**
```ts
toggleTheme(): void { /* toggles isDarkMode signal, sets body.dark-theme class, persists in localStorage */ }
initializeTheme(): void { /* reads localStorage['stats-theme'], falls back to prefers-color-scheme */ }
```

**TrackBy functions** (prevent full DOM re-renders on refresh)
```ts
trackByContainer, trackByEngine, trackByTreeNode, trackByWebsite
```

**Auto-refresh** — `setInterval(() => this.refresh(), 2 * 60 * 60 * 1000)` (every 2 hours)

---

## 5. Features Built

### 5.1 CPU / Memory / Disk Cards
- 3-column metrics grid
- Large percentage value with color class (`healthy` / `warning` / `critical`)
- `mat-progress-bar` for visual fill
- Memory shows used / total in GB

### 5.2 Docker Status Card
- Summary line: `Running: N | Stopped: N`
- Per-container list with left border color indicator (green = running, red = stopped)
- Container name in monospace font, colored by state
- Sub-line: `state · status` (e.g. `running · Up 3 days`)

### 5.3 Database Status Card
- `Online` / `Offline` / `Not detected` chip
- Per-engine grid (MySQL, PostgreSQL, MongoDB, Redis, etc.)

### 5.4 Storage Usage Treemap
- Horizontal scrollable flex layout
- Each block sized by `flex: ratio`
- Labels: directory path, usage %, size in GB
- 3 alternating color gradients (blue, amber, green)
- Loaded with `@defer (on viewport)` — only renders when scrolled into view

### 5.5 Website Status Grid
- 9 monitored domains:
  - `stats.viralpatelstudio.in`
  - `accounts.viralpatelstudio.in`
  - `viralpatelstudio.in`
  - `pravinroadways.com`
  - `thecreativeminds.co.in`
  - `swapnilpatel.in`
  - `mumbaiinteriors.com`
  - `hometrainer.in`
  - `bharatarthandolan.com`
- Per-domain card: hostname, `↗` open-in-new-tab link, response time (color-coded), HTTP code, up/down status
- Response time classes: `response-fast` (green, <300ms), `response-medium` (amber, 300–500ms), `response-slow` (red, >500ms)
- Loaded with `@defer (on viewport)`

### 5.6 Global Health Badge
- Top-right of header, color-coded border + text
- `✓ Healthy` (green) / `● Caution` (amber) / `● Critical` (red)
- Aggregates: CPU ≥85%, Memory ≥85%, Disk ≥85%, any stopped Docker container, DB down, any website down

---

## 6. Performance Optimizations

| Optimization | Implementation | Benefit |
|---|---|---|
| `ChangeDetectionStrategy.OnPush` | `@Component` decorator | Only re-renders when signal/input changes |
| `computed()` for healthStatus | Replaces method calls in template | Computed once per metrics update |
| `trackBy` on all `*ngFor` | `trackByContainer/Engine/TreeNode/Website` | Prevents full DOM re-creation on refresh |
| `@defer (on viewport)` | Treemap + Websites sections | Defers render until scrolled into view |
| `provideZoneChangeDetection({ eventCoalescing: true })` | `app.config.ts` | Batches multiple sync events into single CD cycle |
| 30s metrics cache | `server/index.js` | Prevents redundant shell probes |
| 10min storage tree cache | `server/index.js` | `du` scan is slow; cache avoids re-running |
| 5min website status cache | `server/index.js` | Avoids re-curling 9 URLs on every page load |
| Concurrent request coalescing | `metricsInFlight` promise | Multiple simultaneous requests share one fetch |
| CPU sampled first (serial) | Before all parallel probes | Eliminates self-inflated CPU readings |
| 45s `du` timeout + fallback | `getStorageTreeMapCached()` | Prevents silent empty treemap on slow scans |

---

## 7. UI/UX Improvements

### Header Actions Layout (latest change)
The 4 header items were previously stacked in a single column. Restructured into two rows:

**Structure:**
```html
<div class="actions">
  <div class="status-row">         <!-- Row 1: ✓ Healthy + Synced now -->
    <div class="health-badge">...</div>
    <span class="last-updated">Synced now</span>
  </div>
  <div class="btn-row">            <!-- Row 2: Dark button + Refresh button -->
    <button class="theme-btn">Dark</button>
    <button class="refresh-btn">↻ Refresh now</button>
  </div>
</div>
```

**Desktop**: Right-aligned column of two rows  
**Mobile (≤768px)**: Full-width, left-aligned; buttons stretch equally via `flex: 1`

### Typography & Spacing
- Health badge: `0.4rem 0.8rem` padding, `0.85rem` font, `0.5rem` border-radius, 2px colored border
- Container names: `Monaco`/`Courier New` monospace, state-colored
- Compact padding throughout (reduced from 2rem gaps to 0.8rem)
- `clamp(1.6rem, 2.8vw, 2.3rem)` fluid h1 font size

### Grid Layout
- Metrics: 3-column → 2-column (768px) → 1-column (480px)
- Status (Docker + DB): 2-column → 1-column (768px)
- Websites: 3-column → 2-column (1024px) → 2-column (768px) → 1-column (480px)

### Unicode Glyphs (no Material icon font dependency)
- Refresh icon: `↻` (instead of `<mat-icon>refresh</mat-icon>`)
- Open link: `↗` (instead of `<mat-icon>open_in_new</mat-icon>`)

---

## 8. Dark Mode

### Implementation
- `body.dark-theme` CSS class toggled via `document.body.classList`
- Signal `isDarkMode` drives button label (`Dark` / `Light`)
- Persisted in `localStorage['stats-theme']`
- Initialization order: `localStorage` → `prefers-color-scheme` → default light

### CSS Strategy
Uses `:host-context(body.dark-theme)` blocks in `app.scss` (no separate theme file):
- Background: deep navy gradient (`#101821` → `#15222b`)
- Cards: `#1a2731`, border `#2a3a47`
- Theme button: `#2d3b46` background
- Website items: `#1f2d38`
- Muted text: `#b8c9d7`

---

## 9. Bug Fixes & Production Incidents

### Bug 1 — Storage Treemap Always Empty
**Symptom**: "No storage distribution data available" every load  
**Root Cause**: `du -x -B1 -d 1 /` was silently timing out at the default 12-second `safeExec` limit  
**Fix**:
1. Increased `du` timeout to 45 seconds
2. Added fallback: if `du` fails or times out, scan predefined top-level directories individually
3. Added 10-minute cache so the slow scan rarely runs

### Bug 2 — CPU Always ~100%
**Symptom**: CPU usage card always showed near 100% regardless of actual load  
**Root Cause**: CPU was sampled as part of a `Promise.all()` alongside `du`, Docker, and website curl calls; those heavy probes consumed the CPU being measured  
**Fix**: Moved CPU sampling to before the parallel probe block (serial, first operation)

### Bug 3 — DatePipe / MatIconModule Compile Errors
**Symptom**: Angular build failed with "X is listed in imports but not imported"  
**Root Cause**: `DatePipe` and `MatIconModule` were removed from the TypeScript `import` statements but left in the `@Component.imports` array  
**Fix**: Removed both from the `imports` array; replaced Material icons with unicode glyphs

### Bug 4 — NG0908 Black Page (Production Outage)
**Symptom**: Site showed completely black page after deploying dark mode build; browser console showed `NG0908: NgZone factory not found`  
**Root Cause**: Angular 21 does not bundle `zone.js` by default. The project had no `zone.js` dependency and no import, so `NgZone` failed to initialize at bootstrap  
**Fix**:
1. Added `import 'zone.js'` as the first line of `src/main.ts`
2. Added `"zone.js": "~0.15.1"` to `package.json` dependencies
3. Ran `npm install`, rebuilt bundle (`main-X7J4FFSB.js`), deployed — site recovered

### Bug 5 — Runtime `chrome.runtime.lastError` in Console
**Symptom**: Console showed `lastError` messages  
**Root Cause**: Browser extension interference (not app code)  
**Fix**: No action required — confirmed not from the Angular app

---

## 10. All File Changes

### `src/main.ts`
```ts
import 'zone.js';  // Added — was missing, caused NG0908
import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';

bootstrapApplication(App, appConfig).catch((err) => console.error(err));
```

### `package.json`
- Added `"zone.js": "~0.15.1"` to `dependencies`

### `angular.json`
- `anyComponentStyle.maximumWarning` raised from `4kB` to `6kB` (component styles grew with dark mode)

### `src/app/app.config.ts`
- Added `provideZoneChangeDetection({ eventCoalescing: true })` to providers

### `src/app/app.ts`
- `ChangeDetectionStrategy.OnPush` added
- `healthStatus` converted from method to `computed()` signal
- `isDarkMode = signal(false)` + `toggleTheme()` + `initializeTheme()` added
- Four `trackBy` functions added: `trackByContainer`, `trackByEngine`, `trackByTreeNode`, `trackByWebsite`
- `getContainerStatusColor(state)` helper added
- `getWebsiteResponseClass(ms)` helper added
- `MetricsResponse` interface extended with `docker.containers[]` full shape and `websites[]` array
- Removed `DatePipe` and `MatIconModule` from imports array

### `src/app/app.html`
- Header actions restructured into `.status-row` + `.btn-row` sub-groups
- Health badge added with `[style.borderColor]` and `[style.color]` bound to `healthStatus()`
- Theme toggle button added: `{{ isDarkMode() ? 'Light' : 'Dark' }}`
- Refresh button: replaced `<mat-icon>` with `<span class="refresh-glyph">↻</span>`
- Docker section: stacked layout — monospace name + state-colored border + meta sub-line
- `trackBy:` added to all `*ngFor` directives
- `@defer (on viewport)` wrapping treemap section and websites section
- Website grid with per-site `↗` anchor tag (`target="_blank" rel="noopener noreferrer"`)
- Running/stopped counts added to Docker card header

### `src/app/app.scss`
- `.actions` changed from `display: grid` to `display: flex; flex-direction: column; align-items: flex-end`
- `.status-row` and `.btn-row` classes added
- Dark mode: `:host-context(body.dark-theme)` blocks for all themed elements
- Responsive breakpoints:
  - `@media (max-width: 1024px)`: websites → 2 columns
  - `@media (max-width: 768px)`: header stacks vertically; buttons full-width equal-flex; grids → 2 columns
  - `@media (max-width: 480px)`: all grids → 1 column
- Website grid: `repeat(3, 1fr)` desktop
- Website item: card-style (`background: #f8fafb`, `border-radius: 0.4rem`)
- `↗` link: circle button style (22×22px, hover effect)
- Response time color classes: `.response-fast/medium/slow`
- Treemap: horizontal scrollable flex, `min-height: 160px`, alternating node colors
- Container name: `Monaco`/`Courier New` monospace
- Compact spacing throughout (reduced margins/padding)

### `server/index.js` (deployed at `/opt/stats-dashboard-api/index.js`)
- Added in-memory caching for metrics (30s), storage tree (10min), website status (5min)
- Added `metricsInFlight` promise for concurrent request coalescing
- `getDockerStatus()`: rewrote to use `docker ps -a` with tab-separated format for all containers
- `getWebsiteStatusCached()`: added 9-domain curl probes with response time measurement
- `getStorageTreeMapCached()`: increased `du` timeout to 45s, added per-directory fallback
- CPU sampling moved to top of metrics collection (serial, before parallel probes)
- `safeExec()`: added per-call `timeoutMs` option

---

## 11. Responsive Layout Reference

| Breakpoint | Metrics Grid | Status Grid | Website Grid | Header Actions |
|---|---|---|---|---|
| Desktop (>1024px) | 3 columns | 2 columns | 3 columns | Right-aligned, 2 rows |
| Tablet (769–1024px) | 3 columns | 2 columns | 2 columns | Right-aligned, 2 rows |
| Mobile (481–768px) | 2 columns | 1 column | 2 columns | Full-width, stacked, buttons equal-stretch |
| Small mobile (≤480px) | 1 column | 1 column | 1 column | Full-width, badge smaller |

---

## 12. Production State

| Item | Value |
|---|---|
| Live URL | https://stats.viralpatelstudio.in |
| Server IP | `68.183.81.164` |
| Web root | `/var/www/stats.viralpatelstudio.in/` |
| Latest bundle | `main-RZWNFL26.js` (473.70 kB) |
| CSS bundle | `styles-OPUTW5UJ.css` (8.04 kB) |
| API service | `stats-dashboard-api` (systemd, port 3510) |
| TLS cert | Let's Encrypt, expires 2026-07-12, auto-renew |
| Angular version | 21.2 |
| Zone.js version | ~0.15.1 |

### Deployment Command
```bash
npm run build
scp -r dist/stats-dashboard/browser/* root@68.183.81.164:/var/www/stats.viralpatelstudio.in/
```

### Verify Deploy
```bash
curl -I https://stats.viralpatelstudio.in          # Expect HTTP 200
curl -s https://stats.viralpatelstudio.in | grep "main-"  # Confirm bundle hash
```

---

## Potential Next Steps (not yet implemented)

1. **Route-level lazy loading** — Split `DashboardComponent` into a lazy-loaded route
2. **Material dark theme** — True `@use mat.theme()` dark variant instead of CSS-only overrides
3. **Configurable refresh interval** — Currently hardcoded at 2 hours
4. **Prettier/ESLint enforcement** — `prettier` is in `devDependencies` but not enforced
5. **SCSS budget** — Currently ~4.6kB (warning threshold at 6kB); could compress if needed
6. **WebSocket / SSE** — Replace polling with real-time push from server
