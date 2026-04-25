import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import os from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const execFileAsync = promisify(execFile);
const app = express();
const PORT = Number(process.env.PORT || 3510);
const HOST = process.env.HOST || '0.0.0.0';
const METRICS_CACHE_TTL_MS = Number(process.env.METRICS_CACHE_TTL_MS || 5000);
const STORAGE_TREE_CACHE_TTL_MS = Number(process.env.STORAGE_TREE_CACHE_TTL_MS || 10 * 60 * 1000);
const WEBSITE_STATUS_CACHE_TTL_MS = Number(process.env.WEBSITE_STATUS_CACHE_TTL_MS || 5 * 60 * 1000);
const WEBSITE_TARGETS = (process.env.WEBSITE_TARGETS || [
  'stats.viralpatelstudio.in',
  'accounts.viralpatelstudio.in',
  'viralpatelstudio.in',
  'pravinroadways.com',
  'thecreativeminds.co.in',
  'swapnilpatel.in',
  'mumbaiinteriors.com',
  'hometrainer.in',
  'bharatarthandolan.com'
].join(',')).split(',').map((host) => host.trim()).filter(Boolean);

let metricsCache = {
  payload: null,
  expiresAt: 0
};
let metricsInFlight = null;

let storageTreeCache = {
  payload: [],
  expiresAt: 0
};

let websiteStatusCache = {
  payload: [],
  expiresAt: 0
};

app.use(helmet({
  contentSecurityPolicy: false
}));
app.use(cors());
app.use(compression());

app.get('/health', (_, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

app.get('/metrics', async (req, res) => {
  try {
    const forceFresh = req.query.fresh === '1';
    const payload = await getMetricsWithCache(forceFresh);
    res.set('Cache-Control', 'no-store');
    res.json(payload);
  } catch (error) {
    res.status(500).json({
      message: 'Failed to collect metrics',
      error: error instanceof Error ? error.message : 'unknown error'
    });
  }
});

app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = async () => {
    try {
      const payload = await getMetricsWithCache(false);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch (error) {
      console.error('SSE Error:', error);
    }
  };

  // Send initial data
  sendEvent();

  const interval = setInterval(sendEvent, 5000); // Stream every 5s

  req.on('close', () => {
    clearInterval(interval);
  });
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, HOST, () => {
    console.log(`stats-dashboard-api listening on http://${HOST}:${PORT}`);
  });
}

export async function getMetricsWithCache(forceFresh) {
  const now = Date.now();

  if (!forceFresh && metricsCache.payload && now < metricsCache.expiresAt) {
    return metricsCache.payload;
  }

  if (metricsInFlight) {
    return metricsInFlight;
  }

  metricsInFlight = collectMetrics()
    .then((payload) => {
      metricsCache = {
        payload,
        expiresAt: Date.now() + METRICS_CACHE_TTL_MS
      };
      return payload;
    })
    .catch((error) => {
      if (metricsCache.payload) {
        return metricsCache.payload;
      }
      throw error;
    })
    .finally(() => {
      metricsInFlight = null;
    });

  return metricsInFlight;
}

export async function collectMetrics() {
  // Sample CPU before running expensive probes to avoid self-inflated readings.
  const cpuUsagePercent = await getCpuUsagePercent();

  const [diskUsage, dockerStatus, databaseStatus, websites] = await Promise.all([
    getDiskUsage(),
    getDockerStatus(),
    getDatabaseStatus(),
    getWebsiteStatusCached()
  ]);

  // Use the collected diskUsage to calculate storage tree with proper ratios relative to total capacity
  const storageTree = await getStorageTreeMapCached(diskUsage.totalBytes, diskUsage.usedBytes);

  const totalMemory = os.totalmem();
  const usedMemory = totalMemory - os.freemem();

  return {
    timestamp: new Date().toISOString(),
    cpu: {
      usagePercent: cpuUsagePercent
    },
    memory: {
      usagePercent: pct(usedMemory, totalMemory),
      totalBytes: totalMemory,
      usedBytes: usedMemory
    },
    disk: diskUsage,
    docker: dockerStatus,
    database: databaseStatus,
    storageTree,
    websites
  };
}

export async function getCpuUsagePercent() {
  const start = cpuSnapshot();
  await sleep(300);
  const end = cpuSnapshot();

  const idleDiff = end.idle - start.idle;
  const totalDiff = end.total - start.total;
  if (totalDiff <= 0) {
    return 0;
  }

  return Number(((1 - idleDiff / totalDiff) * 100).toFixed(2));
}

export function cpuSnapshot() {
  return os.cpus().reduce(
    (acc, core) => {
      const times = core.times;
      const total = times.user + times.nice + times.sys + times.irq + times.idle;
      acc.total += total;
      acc.idle += times.idle;
      return acc;
    },
    { idle: 0, total: 0 }
  );
}

export async function getDiskUsage() {
  const { stdout } = await safeExec('df', ['-B1', '--output=size,used,avail,pcent,target', '/']);
  const lines = stdout?.trim().split('\n') || [];
  const details = lines[1]?.trim().split(/\s+/) ?? [];

  const totalBytes = Number(details[0] || 0);
  const usedBytes = Number(details[1] || 0);
  const availableBytes = Number(details[2] || 0);
  const usagePercent = Number((details[3] || '0').replace('%', ''));
  const mount = details[4] || '/';

  return {
    mount,
    usagePercent,
    totalBytes,
    usedBytes,
    availableBytes
  };
}

export async function getDockerStatus() {
  const info = await safeExec('docker', ['info']);
  if (!info.ok) {
    return {
      running: false,
      runningCount: 0,
      stoppedCount: 0,
      totalCount: 0,
      containers: []
    };
  }

  const list = await safeExec('docker', ['ps', '-a', '--format', '{{.Names}}\t{{.State}}\t{{.Status}}\t{{.Image}}']);
  const containers = list.stdout
    ? list.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [name = 'unknown', state = 'unknown', status = 'unknown', image = 'unknown'] = line.split('\t');
          return {
            name,
            state,
            status,
            image,
            lastSeenAt: new Date().toISOString()
          };
        })
    : [];
  const runningCount = containers.filter((container) => container.state === 'running').length;
  const totalCount = containers.length;
  const stoppedCount = Math.max(totalCount - runningCount, 0);

  return {
    running: runningCount > 0,
    runningCount,
    stoppedCount,
    totalCount,
    containers
  };
}

export async function getDatabaseStatus() {
  const engines = ['mysql', 'mariadb', 'postgres', 'mongodb', 'redis'];
  const dockerDb = await safeExec('docker', ['ps', '--format', '{{.Image}} {{.Names}}']);

  const results = [];
  for (const engine of engines) {
    const containerUp = dockerDb.ok && new RegExp(engine, 'i').test(dockerDb.stdout);
    const serviceName = engine === 'postgres' ? 'postgresql' : engine;
    const serviceCheck = await safeExec('systemctl', ['is-active', serviceName]);
    const serviceUp = serviceCheck.ok && serviceCheck.stdout.trim() === 'active';

    let status = 'down';
    if (containerUp || serviceUp) {
      status = 'up';
    } else if (!dockerDb.ok && !serviceCheck.ok) {
      status = 'not-detected';
    }

    results.push({
      name: engine,
      status,
      source: containerUp ? 'docker' : serviceUp ? 'systemd' : 'probe'
    });
  }

  const hasUp = results.some((entry) => entry.status === 'up');
  const hasDown = results.some((entry) => entry.status === 'down');

  return {
    overall: hasUp ? 'up' : hasDown ? 'down' : 'not-detected',
    engines: results
  };
}

export async function getStorageTreeMap(totalBytes, usedBytes) {
  const tree = await safeExec(
    'bash',
    ['-lc', "du -x -B1 -d 1 / 2>/dev/null | sort -nr | head -n 12"],
    { timeoutMs: 45000 }
  );

  let rows = [];
  if (tree.ok && tree.stdout) {
    rows = tree.stdout
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [sizeRaw, path] = line.split(/\s+/, 2);
        return {
          path,
          sizeBytes: Number(sizeRaw || 0)
        };
      })
      .filter((entry) => entry.path !== '/' && entry.path !== '');
  }

  if (rows.length === 0) {
    const fallback = await safeExec(
      'bash',
      [
        '-lc',
        "for p in /var /usr /opt /home /etc /root /tmp; do [ -d \"$p\" ] && du -sx -B1 \"$p\" 2>/dev/null; done | sort -nr | head -n 8"
      ],
      { timeoutMs: 18000 }
    );
    if (fallback.ok && fallback.stdout) {
      rows = fallback.stdout
        .trim()
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [sizeRaw, path] = line.split(/\s+/, 2);
          return {
            path,
            sizeBytes: Number(sizeRaw || 0)
          };
        });
    }
  }

  // Sort and take top 8 directories
  rows.sort((a, b) => b.sizeBytes - a.sizeBytes);
  const topRows = rows.slice(0, 8);
  const sumTop = topRows.reduce((acc, node) => acc + node.sizeBytes, 0);

  const results = topRows.map((entry) => ({
    ...entry,
    ratio: Number((entry.sizeBytes / Math.max(totalBytes, 1)).toFixed(4))
  }));

  // Add "Other files" (Used - sum of top directories)
  const otherBytes = Math.max(0, usedBytes - sumTop);
  if (otherBytes > 0) {
    results.push({
      path: '[other]',
      sizeBytes: otherBytes,
      ratio: Number((otherBytes / Math.max(totalBytes, 1)).toFixed(4))
    });
  }

  // Add "Free Space"
  const freeBytes = Math.max(0, totalBytes - usedBytes);
  if (freeBytes > 0) {
    results.push({
      path: '[free]',
      sizeBytes: freeBytes,
      ratio: Number((freeBytes / Math.max(totalBytes, 1)).toFixed(4))
    });
  }

  return results;
}

export async function getStorageTreeMapCached(totalBytes, usedBytes) {
  const now = Date.now();
  if (storageTreeCache.payload.length && now < storageTreeCache.expiresAt) {
    return storageTreeCache.payload;
  }

  const tree = await getStorageTreeMap(totalBytes, usedBytes);
  storageTreeCache = {
    payload: tree,
    expiresAt: Date.now() + STORAGE_TREE_CACHE_TTL_MS
  };

  return tree;
}

export async function getWebsiteStatusCached() {
  const now = Date.now();
  if (websiteStatusCache.payload.length && now < websiteStatusCache.expiresAt) {
    return websiteStatusCache.payload;
  }

  const checks = await Promise.all(
    WEBSITE_TARGETS.map(async (host) => {
      const startedAt = Date.now();
      let httpCode = 0;
      let status = 'down';

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);

        const response = await fetch(`https://${host}`, {
          method: 'GET',
          signal: controller.signal,
          headers: {
            'User-Agent': 'StatsDashboard/1.0'
          }
        });

        clearTimeout(timeout);
        httpCode = response.status;
        status = httpCode >= 200 && httpCode < 400 ? 'up' : 'down';
      } catch (error) {
        // httpCode remains 0, status remains 'down'
      }

      return {
        host,
        status,
        httpCode,
        responseMs: Date.now() - startedAt,
        checkedAt: new Date().toISOString()
      };
    })
  );

  websiteStatusCache = {
    payload: checks,
    expiresAt: Date.now() + WEBSITE_STATUS_CACHE_TTL_MS
  };

  return checks;
}

export async function safeExec(command, args, options = {}) {
  try {
    const output = await execFileAsync(command, args, {
      timeout: options.timeoutMs ?? 12000,
      maxBuffer: 8 * 1024 * 1024
    });
    return {
      ok: true,
      stdout: output.stdout || '',
      stderr: output.stderr || ''
    };
  } catch (error) {
    return {
      ok: false,
      stdout: error?.stdout || '',
      stderr: error?.stderr || ''
    };
  }
}

export function pct(used, total) {
  if (total <= 0) {
    return 0;
  }
  return Number(((used / total) * 100).toFixed(2));
}

export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export default app;
