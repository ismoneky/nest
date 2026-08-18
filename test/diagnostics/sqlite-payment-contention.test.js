const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '../..');
const diagnosticScript = path.join(projectRoot, 'scripts/diagnose-sqlite-payment-contention.js');

test('diagnostic CLI explains its production-safe server usage', () => {
  const result = spawnSync(process.execPath, [diagnosticScript, '--help'], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 2_000,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /temporary SQLite/i);
  assert.match(result.stdout, /does not call the real WeChat API/i);
  assert.match(result.stdout, /--output/);
});

test('diagnostic CLI detects payment lookup starvation caused by SQLite lock waits', () => {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-diagnostic-test-'));
  const outputPath = path.join(tempDirectory, 'report.json');
  const productionSentinel = path.join(tempDirectory, 'production.sqlite');
  const sentinelContents = 'must-not-be-touched';
  fs.writeFileSync(productionSentinel, sentinelContents, 'utf8');

  try {
    const result = spawnSync(
      process.execPath,
      [diagnosticScript, '--quick', `--output=${outputPath}`],
      {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 20_000,
        env: { ...process.env, DATABASE_PATH: productionSentinel },
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Scenario results:/);
    assert.match(result.stdout, /Production-only unknowns:/);
    assert.equal(fs.readFileSync(productionSentinel, 'utf8'), sentinelContents);

    const report = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.equal(report.reportVersion, 1);
    assert.equal(report.safety.usesTemporaryDatabaseOnly, true);
    assert.equal(report.safety.callsRealWechatApi, false);

    const pool4 = report.scenarios.find((scenario) => scenario.id === 'sqlite-contention-pool-4');
    const pool16 = report.scenarios.find((scenario) => scenario.id === 'sqlite-contention-pool-16');

    assert.ok(pool4, 'missing pool-4 contention scenario');
    assert.ok(pool16, 'missing pool-16 contention scenario');
    assert.equal(pool4.sqliteBusyCount, 4);
    assert.equal(pool16.sqliteBusyCount, 4);
    assert.ok(
      pool4.mockPaymentLookupMs >= pool4.busyTimeoutMs * 0.7,
      `pool-4 lookup was not starved: ${pool4.mockPaymentLookupMs}ms`,
    );
    assert.ok(
      pool16.mockPaymentLookupMs < pool4.mockPaymentLookupMs * 0.5,
      `pool-16 lookup was not materially faster: pool4=${pool4.mockPaymentLookupMs}ms pool16=${pool16.mockPaymentLookupMs}ms`,
    );
    assert.equal(report.diagnosis.sqliteThreadpoolCouplingDetected, true);
    assert.equal(report.diagnosis.pragmaAssessment.synchronousNormalApplied, false);
    assert.ok(Array.isArray(report.diagnosis.riskClassifications));
    assert.ok(report.diagnosis.riskClassifications.length >= 5);
    assert.ok(
      report.diagnosis.riskClassifications.every((risk) =>
        ['observed', 'not_observed', 'production_only'].includes(risk.status),
      ),
    );
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
});
