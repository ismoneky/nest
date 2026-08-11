#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const dns = require('node:dns');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const sqlite3 = require('sqlite3');

const REPORT_VERSION = 1;
const TEMP_PREFIX = 'ff-sqlite-payment-diagnostic';

function hasFlag(name) {
  return process.argv.includes(name);
}

function readArg(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function percentile(values, ratio) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function openDb(databasePath) {
  return new sqlite3.Database(databasePath);
}

function dbRun(db, sql) {
  return new Promise((resolve, reject) => {
    db.run(sql, (error) => (error ? reject(error) : resolve()));
  });
}

function closeDb(db) {
  return new Promise((resolve) => db.close(resolve));
}

function removeSqliteFiles(databasePath) {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try {
      fs.rmSync(`${databasePath}${suffix}`, { force: true });
    } catch {}
  }
}

async function startMockPaymentServer(responseDelayMs) {
  const server = http.createServer((_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"prepay_id":"mock-prepay-id"}');
    }, responseDelayMs);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  return {
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function requestMockPayment({ port, agent }) {
  const startedAt = Date.now();
  let socketAssignedMs = null;
  let lookupMs = null;
  let connectMs = null;
  let firstByteMs = null;

  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: 'localhost',
        port,
        path: '/v3/pay/transactions/jsapi',
        method: 'POST',
        agent,
        lookup: (hostname, _options, callback) => {
          dns.lookup(hostname, { family: 4 }, (error, address, family) => {
            if (error) return callback(error);
            if (!address.startsWith('127.')) {
              return callback(new Error(`Refusing non-loopback localhost address: ${address}`));
            }
            return callback(null, '127.0.0.1', family);
          });
        },
        headers: {
          'content-type': 'application/json',
          'content-length': '2',
        },
      },
      (response) => {
        firstByteMs = Date.now() - startedAt;
        response.resume();
        response.once('end', () => {
          resolve({
            totalMs: Date.now() - startedAt,
            socketAssignedMs,
            lookupMs,
            connectMs,
            firstByteMs,
            reusedSocket: request.reusedSocket === true,
          });
        });
      },
    );

    request.once('socket', (socket) => {
      socketAssignedMs = Date.now() - startedAt;
      socket.once('lookup', () => {
        lookupMs = Date.now() - startedAt;
      });
      socket.once('connect', () => {
        connectMs = Date.now() - startedAt;
      });
    });
    request.once('error', reject);
    request.setTimeout(10_000, () => request.destroy(new Error('mock payment request timed out')));
    request.end('{}');
  });
}

async function runWorkerScenario(options) {
  const databasePath = path.join(os.tmpdir(), `${TEMP_PREFIX}-${process.pid}.sqlite`);
  const mockServer = await startMockPaymentServer(options.serverDelayMs);
  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  const holder = openDb(databasePath);
  const contenders = [];
  const agent = new http.Agent({
    keepAlive: options.keepAlive,
    maxSockets: options.maxSockets,
    maxFreeSockets: Math.min(2, options.maxSockets),
  });

  eventLoop.enable();

  try {
    await dbRun(holder, 'CREATE TABLE counters (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)');
    await dbRun(holder, 'INSERT INTO counters (id, value) VALUES (1, 0)');
    await dbRun(holder, `PRAGMA busy_timeout = ${options.busyTimeoutMs}`);

    if (options.blockedWriters > 0) {
      await dbRun(holder, 'BEGIN IMMEDIATE');
      await dbRun(holder, 'UPDATE counters SET value = value + 1 WHERE id = 1');
    }

    for (let index = 0; index < options.blockedWriters; index += 1) {
      const contender = openDb(databasePath);
      contenders.push(contender);
      await dbRun(contender, `PRAGMA busy_timeout = ${options.busyTimeoutMs}`);
    }

    if (options.warmConnection) {
      await requestMockPayment({ port: mockServer.port, agent });
    }

    const blockedWrites = contenders.map((db) =>
      dbRun(db, 'UPDATE counters SET value = value + 1 WHERE id = 1')
        .then(() => 'OK')
        .catch((error) => error.code || error.message),
    );

    await new Promise((resolve) => setTimeout(resolve, 40));

    const paymentStartedAt = Date.now();
    const paymentRequests = await Promise.all(
      Array.from({ length: options.paymentRequests }, () =>
        requestMockPayment({ port: mockServer.port, agent }),
      ),
    );
    const paymentBatchMs = Date.now() - paymentStartedAt;
    const writeResults = await Promise.all(blockedWrites);

    if (options.blockedWriters > 0) {
      await dbRun(holder, 'ROLLBACK');
    }

    eventLoop.disable();

    const totals = paymentRequests.map((request) => request.totalMs);
    const socketWaits = paymentRequests.map((request) => request.socketAssignedMs ?? request.totalMs);
    const lookups = paymentRequests
      .map((request) => request.lookupMs)
      .filter((value) => value !== null);

    return {
      id: options.id,
      threadpoolSize: Number(process.env.UV_THREADPOOL_SIZE || 4),
      keepAlive: options.keepAlive,
      warmConnection: options.warmConnection,
      maxSockets: options.maxSockets,
      blockedWriters: options.blockedWriters,
      sqliteBusyCount: writeResults.filter((result) => result === 'SQLITE_BUSY').length,
      busyTimeoutMs: options.busyTimeoutMs,
      paymentRequests: options.paymentRequests,
      paymentBatchMs,
      mockPaymentLookupMs: lookups.length > 0 ? Math.max(...lookups) : 0,
      paymentLatencyMs: {
        min: Math.min(...totals),
        median: percentile(totals, 0.5),
        p95: percentile(totals, 0.95),
        max: Math.max(...totals),
      },
      socketAssignedMs: {
        median: percentile(socketWaits, 0.5),
        p95: percentile(socketWaits, 0.95),
        max: Math.max(...socketWaits),
      },
      reusedSocketCount: paymentRequests.filter((request) => request.reusedSocket).length,
      eventLoopDelayMs: {
        mean: Number.isFinite(eventLoop.mean) ? Number((eventLoop.mean / 1e6).toFixed(2)) : 0,
        p95: Number((eventLoop.percentile(95) / 1e6).toFixed(2)),
        max: Number((eventLoop.max / 1e6).toFixed(2)),
      },
      writeResults,
    };
  } finally {
    eventLoop.disable();
    agent.destroy();
    try {
      await dbRun(holder, 'ROLLBACK');
    } catch {}
    await Promise.all(contenders.map(closeDb));
    await closeDb(holder);
    await mockServer.close();
    removeSqliteFiles(databasePath);
  }
}

function workerOptionsFromArgs() {
  return {
    id: readArg('id', 'worker'),
    busyTimeoutMs: Number(readArg('busy-timeout', '1800')),
    blockedWriters: Number(readArg('blocked-writers', '4')),
    paymentRequests: Number(readArg('payment-requests', '1')),
    keepAlive: readArg('keep-alive', '0') === '1',
    warmConnection: readArg('warm-connection', '0') === '1',
    maxSockets: Number(readArg('max-sockets', '5')),
    serverDelayMs: Number(readArg('server-delay', '10')),
  };
}

function spawnScenario(options) {
  const args = [
    __filename,
    '--worker',
    `--id=${options.id}`,
    `--busy-timeout=${options.busyTimeoutMs}`,
    `--blocked-writers=${options.blockedWriters}`,
    `--payment-requests=${options.paymentRequests}`,
    `--keep-alive=${options.keepAlive ? 1 : 0}`,
    `--warm-connection=${options.warmConnection ? 1 : 0}`,
    `--max-sockets=${options.maxSockets}`,
    `--server-delay=${options.serverDelayMs}`,
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: Math.max(20_000, options.busyTimeoutMs * 4),
    env: {
      ...process.env,
      UV_THREADPOOL_SIZE: String(options.threadpoolSize),
    },
  });

  if (result.status !== 0) {
    throw new Error(`Scenario ${options.id} failed:\n${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

async function inspectTypeOrmPragmas() {
  const { DataSource } = require('typeorm');

  async function inspect(label, options) {
    const databasePath = path.join(os.tmpdir(), `${TEMP_PREFIX}-${label}-${process.pid}.sqlite`);
    const dataSource = new DataSource({
      type: 'sqlite',
      database: databasePath,
      entities: [],
      synchronize: false,
      ...options,
    });

    try {
      await dataSource.initialize();
      const [journal] = await dataSource.query('PRAGMA journal_mode');
      const [busy] = await dataSource.query('PRAGMA busy_timeout');
      const [synchronous] = await dataSource.query('PRAGMA synchronous');
      return {
        journalMode: journal.journal_mode,
        busyTimeoutMs: busy.timeout,
        synchronous: synchronous.synchronous,
      };
    } finally {
      if (dataSource.isInitialized) await dataSource.destroy();
      removeSqliteFiles(databasePath);
    }
  }

  return {
    currentExtraPragmaStyle: await inspect('extra', {
      extra: {
        pragma: [
          'journal_mode = WAL',
          'busy_timeout = 5000',
          'synchronous = NORMAL',
        ],
      },
    }),
    supportedOptionStyle: await inspect('supported', {
      enableWAL: true,
      busyTimeout: 5000,
    }),
  };
}

function hostSnapshot() {
  let openFileLimit = null;
  try {
    const limits = fs.readFileSync('/proc/self/limits', 'utf8');
    const line = limits.split('\n').find((entry) => entry.startsWith('Max open files'));
    if (line) openFileLimit = line.trim().split(/\s+/).slice(-3, -2)[0];
  } catch {}

  let diskFreeBytes = null;
  try {
    diskFreeBytes = fs.statfsSync(process.cwd()).bavail * fs.statfsSync(process.cwd()).bsize;
  } catch {}

  return {
    nodeVersion: process.version,
    platform: `${process.platform}-${process.arch}`,
    cpuCount: os.cpus().length,
    totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024),
    freeMemoryMb: Math.round(os.freemem() / 1024 / 1024),
    loadAverage: os.loadavg().map((value) => Number(value.toFixed(2))),
    openFileLimit,
    diskFreeBytes,
  };
}

function buildDiagnosis(scenarios, pragmaCheck) {
  const pool4 = scenarios.find((scenario) => scenario.id === 'sqlite-contention-pool-4');
  const pool16 = scenarios.find((scenario) => scenario.id === 'sqlite-contention-pool-16');
  const keepAlive = scenarios.find((scenario) => scenario.id === 'sqlite-contention-pool-4-keepalive');
  const agentQueue = scenarios.find((scenario) => scenario.id === 'agent-max-sockets-queue');

  const sqliteThreadpoolCouplingDetected =
    pool4.mockPaymentLookupMs >= pool4.busyTimeoutMs * 0.7 &&
    pool16.mockPaymentLookupMs < pool16.busyTimeoutMs * 0.5;
  const keepAliveBypassesLookupContention =
    keepAlive.paymentLatencyMs.p95 < pool4.busyTimeoutMs * 0.5 &&
    keepAlive.reusedSocketCount > 0;
  const agentSocketQueueDetected =
    agentQueue.socketAssignedMs.p95 >= agentQueue.paymentLatencyMs.min * 0.7;
  const typeOrmExtraPragmaApplied =
    pragmaCheck.currentExtraPragmaStyle.journalMode === 'wal' &&
    pragmaCheck.currentExtraPragmaStyle.busyTimeoutMs === 5000;
  const synchronousNormalApplied =
    pragmaCheck.currentExtraPragmaStyle.synchronous === 1;
  const maxEventLoopP95 = Math.max(
    ...scenarios.map((scenario) => scenario.eventLoopDelayMs.p95),
  );

  const findings = [];
  if (sqliteThreadpoolCouplingDetected) {
    findings.push({
      code: 'SQLITE_LIBUV_COUPLING',
      severity: 'high',
      summary: 'SQLite lock waits can starve DNS/socket setup in the default libuv threadpool.',
      evidence: `pool4 lookup=${pool4.mockPaymentLookupMs}ms, pool16 lookup=${pool16.mockPaymentLookupMs}ms, busyTimeout=${pool4.busyTimeoutMs}ms`,
    });
  }
  if (keepAliveBypassesLookupContention) {
    findings.push({
      code: 'KEEPALIVE_BYPASSES_LOOKUP',
      severity: 'info',
      summary: 'A warmed keep-alive connection skips DNS/socket setup, avoiding the libuv threadpool contention.',
      evidence: `keepalive p95=${keepAlive.paymentLatencyMs.p95}ms, reusedSockets=${keepAlive.reusedSocketCount}, pool4 busyTimeout=${pool4.busyTimeoutMs}ms`,
    });
  }
  if (!typeOrmExtraPragmaApplied) {
    findings.push({
      code: 'TYPEORM_PRAGMA_CONFIGURATION_IGNORED',
      severity: 'info',
      summary: 'The current extra.pragma style does not enable WAL or the intended busy timeout. Out of scope for this iteration; tracked for a later fix.',
      evidence: JSON.stringify(pragmaCheck.currentExtraPragmaStyle),
    });
  }
  if (!synchronousNormalApplied) {
    findings.push({
      code: 'TYPEORM_SYNCHRONOUS_NOT_NORMAL',
      severity: 'info',
      summary: 'The intended synchronous=NORMAL setting is not active. Out of scope for this iteration; tracked for a later fix.',
      evidence: `expected=1 (NORMAL), actual=${pragmaCheck.currentExtraPragmaStyle.synchronous}`,
    });
  }
  if (agentSocketQueueDetected) {
    findings.push({
      code: 'HTTP_AGENT_SOCKET_QUEUE',
      severity: 'medium',
      summary: 'Requests above maxSockets queue behind existing payment calls.',
      evidence: `maxSockets=${agentQueue.maxSockets}, requests=${agentQueue.paymentRequests}, socketWaitP95=${agentQueue.socketAssignedMs.p95}ms`,
    });
  }

  const riskClassifications = [
    {
      code: 'SQLITE_LIBUV_COUPLING',
      status: sqliteThreadpoolCouplingDetected ? 'observed' : 'not_observed',
      evidence: `pool4 lookup=${pool4.mockPaymentLookupMs}ms, pool16 lookup=${pool16.mockPaymentLookupMs}ms`,
    },
    {
      code: 'KEEPALIVE_BYPASSES_LOOKUP',
      status: keepAliveBypassesLookupContention ? 'observed' : 'not_observed',
      evidence: `keepalive p95=${keepAlive.paymentLatencyMs.p95}ms, reusedSockets=${keepAlive.reusedSocketCount}`,
    },
    {
      code: 'HTTP_AGENT_SOCKET_QUEUE',
      status: agentSocketQueueDetected ? 'observed' : 'not_observed',
      evidence: `maxSockets=${agentQueue.maxSockets}, requests=${agentQueue.paymentRequests}, socketWaitP95=${agentQueue.socketAssignedMs.p95}ms`,
    },
    {
      code: 'EVENT_LOOP_STALL_DURING_DIAGNOSTIC',
      status: maxEventLoopP95 >= 100 ? 'observed' : 'not_observed',
      evidence: `maximum event-loop p95=${maxEventLoopP95}ms; diagnostic threshold=100ms`,
    },
    {
      code: 'REAL_WECHAT_NETWORK_LATENCY',
      status: 'production_only',
      evidence: 'The diagnostic intentionally uses a loopback mock and cannot measure real DNS/TCP/TLS/API latency.',
    },
    {
      code: 'CLIENT_REQUEST_STORM',
      status: 'production_only',
      evidence: 'Requires request-rate and idempotency logs from the live application.',
    },
    {
      code: 'RECONCILIATION_COLLISION',
      status: 'production_only',
      evidence: 'Requires live scheduler timing and shared-Agent utilization logs.',
    },
    {
      code: 'HOST_RESOURCE_SATURATION_AT_INCIDENT_TIME',
      status: 'production_only',
      evidence: 'The host snapshot describes only the time of this diagnostic, not the incident window.',
    },
  ];

  return {
    sqliteThreadpoolCouplingDetected,
    keepAliveBypassesLookupContention,
    agentSocketQueueDetected,
    typeOrmExtraPragmaApplied,
    pragmaAssessment: {
      expected: {
        journalMode: 'wal',
        busyTimeoutMs: 5000,
        synchronous: 1,
        synchronousName: 'NORMAL',
      },
      actual: pragmaCheck.currentExtraPragmaStyle,
      walApplied: pragmaCheck.currentExtraPragmaStyle.journalMode === 'wal',
      busyTimeoutApplied: pragmaCheck.currentExtraPragmaStyle.busyTimeoutMs === 5000,
      synchronousNormalApplied,
      note: 'TypeORM enableWAL/busyTimeout cover WAL and busy timeout; synchronous=NORMAL needs an explicit post-connect PRAGMA in this driver version.',
    },
    findings,
    riskClassifications,
  };
}

function printHumanReport(report, outputPath) {
  console.log('SQLite / payment contention diagnostic');
  console.log(`Node ${report.host.nodeVersion}, CPUs ${report.host.cpuCount}, memory ${report.host.freeMemoryMb}/${report.host.totalMemoryMb} MB free`);
  console.log('');
  console.log('Scenario results:');
  for (const scenario of report.scenarios) {
    console.log(
      `- ${scenario.id}: lookup=${scenario.mockPaymentLookupMs}ms, payment-p95=${scenario.paymentLatencyMs.p95}ms, socket-wait-p95=${scenario.socketAssignedMs.p95}ms, event-loop-p95=${scenario.eventLoopDelayMs.p95}ms`,
    );
  }
  console.log('');
  console.log('Findings:');
  if (report.diagnosis.findings.length === 0) {
    console.log('- No findings detected in the isolated diagnostic.');
  } else {
    for (const finding of report.diagnosis.findings) {
      console.log(`- [${finding.severity}] ${finding.code}: ${finding.summary}`);
      console.log(`  ${finding.evidence}`);
    }
  }
  console.log('');
  console.log('Risk classifications:');
  for (const risk of report.diagnosis.riskClassifications.filter((entry) => entry.status !== 'production_only')) {
    console.log(`- [${risk.status}] ${risk.code}: ${risk.evidence}`);
  }
  console.log('');
  console.log('Production-only unknowns:');
  for (const risk of report.diagnosis.riskClassifications.filter((entry) => entry.status === 'production_only')) {
    console.log(`- ${risk.code}: ${risk.evidence}`);
  }
  console.log('');
  console.log(`JSON report written to ${outputPath}`);
}

function printHelp() {
  console.log(`Usage:
  node scripts/diagnose-sqlite-payment-contention.js [options]

Options:
  --quick                 Run a shorter local check for development.
  --json                  Print only JSON to stdout; do not write a report file.
  --output=<path>         Write the JSON report to the selected path.
  --help                  Show this help text.

Safety:
  - Uses a uniquely named temporary SQLite database only.
  - Starts a loopback-only mock payment server.
  - Does not call the real WeChat API.
  - Does not read or modify the configured production database.

Recommended server command:
  node scripts/diagnose-sqlite-payment-contention.js \\
    --output=sqlite-payment-diagnostic.json
`);
}

async function runParent() {
  const quick = hasFlag('--quick');
  const busyTimeoutMs = quick ? 450 : 1800;
  const serverDelayMs = quick ? 15 : 80;
  const scenarios = [
    {
      id: 'baseline-pool-4',
      threadpoolSize: 4,
      blockedWriters: 0,
      paymentRequests: 4,
      keepAlive: false,
      warmConnection: false,
      maxSockets: 5,
      busyTimeoutMs,
      serverDelayMs,
    },
    {
      id: 'sqlite-contention-pool-4',
      threadpoolSize: 4,
      blockedWriters: 4,
      paymentRequests: 1,
      keepAlive: false,
      warmConnection: false,
      maxSockets: 5,
      busyTimeoutMs,
      serverDelayMs,
    },
    {
      id: 'sqlite-contention-pool-16',
      threadpoolSize: 16,
      blockedWriters: 4,
      paymentRequests: 1,
      keepAlive: false,
      warmConnection: false,
      maxSockets: 5,
      busyTimeoutMs,
      serverDelayMs,
    },
    {
      id: 'sqlite-contention-pool-4-keepalive',
      threadpoolSize: 4,
      blockedWriters: 4,
      paymentRequests: 1,
      keepAlive: true,
      warmConnection: true,
      maxSockets: 5,
      busyTimeoutMs,
      serverDelayMs,
    },
    {
      id: 'agent-max-sockets-queue',
      threadpoolSize: 16,
      blockedWriters: 0,
      paymentRequests: 12,
      keepAlive: true,
      warmConnection: false,
      maxSockets: 5,
      busyTimeoutMs,
      serverDelayMs,
    },
  ].map(spawnScenario);

  const pragmaCheck = await inspectTypeOrmPragmas();
  const report = {
    reportVersion: REPORT_VERSION,
    generatedAt: new Date().toISOString(),
    safety: {
      usesTemporaryDatabaseOnly: true,
      callsRealWechatApi: false,
      temporaryFilePrefix: TEMP_PREFIX,
    },
    host: hostSnapshot(),
    typeOrmPragmaCheck: pragmaCheck,
    scenarios,
    diagnosis: buildDiagnosis(scenarios, pragmaCheck),
  };

  if (hasFlag('--json')) {
    process.stdout.write(JSON.stringify(report));
    return;
  }

  const outputArg = readArg('output', null);
  const outputPath = outputArg
    ? path.resolve(outputArg)
    : path.resolve(`sqlite-payment-diagnostic-${Date.now()}.json`);
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  printHumanReport(report, outputPath);
}

async function main() {
  if (hasFlag('--help')) {
    printHelp();
    return;
  }
  if (hasFlag('--worker')) {
    const report = await runWorkerScenario(workerOptionsFromArgs());
    process.stdout.write(JSON.stringify(report));
    return;
  }
  await runParent();
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
