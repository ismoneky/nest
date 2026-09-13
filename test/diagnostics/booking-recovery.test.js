/**
 * 事故恢复工具链的往返测试（scripts/export-bookings-from-api.js + scripts/import-bookings-to-db.js）。
 *
 * 背景见 src/common/transaction-runner.ts：2026-09-13 事故后，磁盘上的 prod.db 缺了一批
 * 「只存在于旧进程连接内存里」的写入，必须先经 HTTP 抢出来，再在重启后补回库。
 * 这条链路直接动生产数据，所以每个安全承诺都要有测试兜住：
 *   · 默认 dry-run，不加 --apply 绝不写库；
 *   · 库被占用（旧进程还挂着开放事务）时拒绝写入并给出恢复指引；
 *   · ISO 字符串 → 毫秒整数、boolean → 0/1、date → YYYY-MM-DD 的类型还原；
 *   · 线上版本更新时让路，绝不回退；
 *   · 重跑幂等；
 *   · 导出 id 被别的订单占用时改由 sqlite 分配，不让整行插入失败。
 *
 * 运行：npm run test:diagnostics
 */

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sqlite3 = require('sqlite3');

const projectRoot = path.resolve(__dirname, '../..');
const exportScript = path.join(projectRoot, 'scripts/export-bookings-from-api.js');
const importScript = path.join(projectRoot, 'scripts/import-bookings-to-db.js');

// ────────────────────────────── 测试脚手架 ──────────────────────────────

/** 与 src/entities/booking.entity.ts 对齐的建表语句（生产由手工 SQL 维护，见 docs/implementation-todo.md） */
const BOOKINGS_DDL = `
CREATE TABLE "bookings" (
  "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  "bookingId" varchar NOT NULL,
  "wechatOpenId" varchar NOT NULL,
  "passengers" text,
  "name" varchar,
  "phone" varchar,
  "idCard" varchar,
  "bookingDate" date NOT NULL,
  "timeSlot" varchar NOT NULL,
  "travelMode" varchar NOT NULL,
  "licensePlate" varchar,
  "vehicleType" varchar,
  "tourGroupName" varchar,
  "tourOrderNumber" varchar,
  "personCount" integer NOT NULL,
  "remarks" varchar NOT NULL DEFAULT (''),
  "isFree" boolean NOT NULL DEFAULT (0),
  "freeReason" varchar,
  "status" varchar NOT NULL DEFAULT ('pending'),
  "paymentStatus" varchar NOT NULL DEFAULT ('unpaid'),
  "refundStatus" varchar NOT NULL DEFAULT ('none'),
  "amount" integer,
  "transactionId" varchar,
  "outTradeNo" varchar,
  "outRefundNo" varchar,
  "paidAt" integer,
  "refundedAt" integer,
  "paymentExpiredAt" integer,
  "reconcileKind" varchar,
  "reconcileNextAt" integer,
  "reconcileAttempts" integer NOT NULL DEFAULT (0),
  "reconcileLastAt" integer,
  "reconcileLastErrorCode" varchar,
  "createdAt" integer NOT NULL,
  "updatedAt" integer NOT NULL
);
CREATE UNIQUE INDEX "IDX_bookings_bookingId" ON "bookings" ("bookingId");
`;

// node-sqlite3 传 OPEN_READWRITE 时不含 OPEN_CREATE，新建库文件会直接 CANTOPEN；
// 建库必须显式带上 CREATE。（生产脚本反过来故意不带：库文件不存在就该拒绝启动，
// 免得在错误路径上「成功」建出一个空库把数据导进空气里。）
const OPEN_RW = sqlite3.OPEN_READWRITE;
const OPEN_RW_CREATE = sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE;

function makeTempDir(label) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `ff-recovery-${label}-`));
}

function openDb(file, mode) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(file, mode, (err) => (err ? reject(err) : resolve(db)));
    });
}
function run(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) { err ? reject(err) : resolve(this); });
    });
}
function all(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
    });
}
function close(db) {
    return new Promise((resolve) => db.close(() => resolve()));
}

async function withDb(file, fn, mode = OPEN_RW_CREATE) {
    const db = await openDb(file, mode);
    try {
        return await fn(db);
    } finally {
        await close(db);
    }
}

/** 建一个带 schema 的空库 */
async function makeDb(dir, existingRows = []) {
    const file = path.join(dir, 'prod.db');
    await withDb(file, async (db) => {
        for (const stmt of BOOKINGS_DDL.split(';')) {
            if (stmt.trim()) await run(db, stmt);
        }
        for (const r of existingRows) {
            const cols = Object.keys(r);
            await run(
                db,
                `INSERT INTO bookings (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
                cols.map((c) => r[c]),
            );
        }
    });
    return file;
}

/** 从接口视角造一条订单：ISO 时间字符串 + boolean，模拟 JSON.parse 之后的样子 */
function apiRow(over = {}) {
    const id = over.id ?? 101;
    return {
        id,
        bookingId: `b-${id}`,
        wechatOpenId: 'o-abc',
        passengers: JSON.stringify([{ name: '张三', phone: '13800000000', idCard: '110101199001011234' }]),
        name: '张三',
        phone: '13800000000',
        idCard: '110101199001011234',
        bookingDate: '2026-09-20',
        timeSlot: 'morning',
        travelMode: 'selfDriving',
        licensePlate: '鄂A12345',
        vehicleType: 'smallCar',
        tourGroupName: null,
        tourOrderNumber: null,
        personCount: 1,
        remarks: '',
        isFree: true,
        freeReason: 'dailyQuota',
        status: 'confirmed',
        paymentStatus: 'paid',
        refundStatus: 'none',
        amount: 5000,
        transactionId: `wx-${id}`,
        outTradeNo: `otn-${id}`,
        outRefundNo: null,
        paidAt: '2026-09-13T02:00:00.000Z',
        refundedAt: null,
        paymentExpiredAt: '2026-09-13T02:30:00.000Z',
        reconcileKind: null,
        reconcileNextAt: null,
        reconcileAttempts: 0,
        reconcileLastAt: null,
        reconcileLastErrorCode: null,
        createdAt: '2026-09-13T01:00:00.000Z',
        updatedAt: '2026-09-13T02:00:00.000Z',
        ...over,
    };
}

function writeExport(dir, bookings) {
    const file = path.join(dir, 'bookings.json');
    fs.writeFileSync(file, JSON.stringify({ meta: { exportedAt: new Date().toISOString() }, bookings }, null, 2), 'utf8');
    return file;
}

/** 库里已有的行：时间是毫秒整数，isFree 是 0/1，bookingDate 是纯日期串 */
function dbRow(over = {}) {
    const id = over.id ?? 900;
    return {
        id,
        bookingId: `b-${id}`,
        wechatOpenId: 'o-abc',
        passengers: '[]',
        name: '李四',
        phone: '13900000000',
        idCard: '110101199001011234',
        bookingDate: '2026-09-01',
        timeSlot: 'afternoon',
        travelMode: 'scenicBus',
        personCount: 2,
        remarks: '',
        isFree: 0,
        status: 'pending',
        paymentStatus: 'unpaid',
        refundStatus: 'none',
        reconcileAttempts: 0,
        createdAt: Date.parse('2026-09-01T00:00:00.000Z'),
        updatedAt: Date.parse('2026-09-01T00:00:00.000Z'),
        ...over,
    };
}

function runImport(args, opts = {}) {
    return spawnSync(process.execPath, [importScript, ...args], {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: 60_000,
        ...opts,
    });
}

/**
 * 异步跑一个脚本。
 * 导出脚本的端到端测试要在**本进程内**起一个假的订单接口，所以只能用 spawn 而不能用
 * spawnSync —— spawnSync 会阻塞父进程事件循环，父进程的 HTTP 服务就没法响应子进程的
 * 请求，两边互等直到超时。
 */
function runNodeAsync(args) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, args, { cwd: projectRoot });
        const out = [];
        const err = [];
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill(); }, 60_000);
        child.stdout.on('data', (d) => out.push(d));
        child.stderr.on('data', (d) => err.push(d));
        child.on('close', (status) => {
            clearTimeout(timer);
            resolve({
                status: timedOut ? null : status,
                stdout: Buffer.concat(out).toString('utf8'),
                stderr: Buffer.concat(err).toString('utf8'),
            });
        });
    });
}

/** 跑一次导入并返回报告 JSON */
function importAndReadReport(dir, args) {
    const report = path.join(dir, `report-${Math.random().toString(36).slice(2)}.json`);
    const res = runImport([...args, `--report=${report}`]);
    const body = fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, 'utf8')) : null;
    return { res, report: body };
}

// ────────────────────────────── 测试 ──────────────────────────────

test('导入默认空跑：不加 --apply 时数据库一个字节都不改', async () => {
    const dir = makeTempDir('dryrun');
    const dbFile = await makeDb(dir);
    const jsonFile = writeExport(dir, [apiRow({ id: 101 }), apiRow({ id: 102 })]);
    const before = fs.readFileSync(dbFile);

    const { res, report } = importAndReadReport(dir, [`--in=${jsonFile}`, `--db=${dbFile}`]);

    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /空跑（dry-run，不改动数据库）/);
    assert.match(res.stdout, /新增：2/);
    assert.equal(report.applied, false);
    assert.equal(report.counts.insert, 2);
    assert.deepEqual(fs.readFileSync(dbFile), before, '空跑后库文件不应有任何变化');
});

test('导入还原存储类型：ISO 时间→毫秒整数、boolean→0/1、date→纯日期串', async () => {
    const dir = makeTempDir('types');
    const dbFile = await makeDb(dir);
    const jsonFile = writeExport(dir, [apiRow({ id: 101 })]);

    const { res } = importAndReadReport(dir, [`--in=${jsonFile}`, `--db=${dbFile}`, '--apply']);
    assert.equal(res.status, 0, res.stderr || res.stdout);

    await withDb(dbFile, async (db) => {
        const [row] = await all(db, 'SELECT * FROM bookings WHERE bookingId = ?', ['b-101']);
        assert.ok(row, '订单应已写入');

        // 这是本脚本最容易出错的地方：直接把 JSON 塞回去会存成 ISO 字符串
        assert.equal(row.paidAt, Date.parse('2026-09-13T02:00:00.000Z'));
        assert.equal(row.createdAt, Date.parse('2026-09-13T01:00:00.000Z'));
        assert.equal(row.updatedAt, Date.parse('2026-09-13T02:00:00.000Z'));
        assert.equal(row.paymentExpiredAt, Date.parse('2026-09-13T02:30:00.000Z'));
        assert.equal(typeof row.paidAt, 'number');

        assert.equal(row.isFree, 1, 'boolean 必须落成 0/1');
        assert.equal(row.bookingDate, '2026-09-20', 'date 列必须是 YYYY-MM-DD');
        assert.equal(row.amount, 5000);
        assert.equal(row.personCount, 1);

        // 可空列在 JSON 里是 null，写库后仍应是 NULL 而不是字符串 "null"
        assert.equal(row.refundedAt, null);
        assert.equal(row.tourGroupName, null);

        // passengers 本身就是 JSON 字符串，应原样保存
        assert.deepEqual(JSON.parse(row.passengers)[0].idCard, '110101199001011234');
    });
});

test('线上版本更新时让路：不回退已提交的更新状态', async () => {
    const dir = makeTempDir('stale');
    // 库里这条订单在导出之后又被更新过（updatedAt 比导出值新）
    const newer = Date.parse('2026-09-13T09:00:00.000Z');
    const dbFile = await makeDb(dir, [
        dbRow({ id: 101, bookingId: 'b-101', status: 'completed', paymentStatus: 'refunded', updatedAt: newer }),
    ]);
    const jsonFile = writeExport(dir, [apiRow({ id: 101, status: 'confirmed', paymentStatus: 'paid' })]);

    const { res, report } = importAndReadReport(dir, [`--in=${jsonFile}`, `--db=${dbFile}`, '--apply']);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /跳过：1/);
    assert.equal(report.counts.stale, 1);

    await withDb(dbFile, async (db) => {
        const [row] = await all(db, 'SELECT * FROM bookings WHERE bookingId = ?', ['b-101']);
        assert.equal(row.status, 'completed', '线上更新的状态必须保住');
        assert.equal(row.paymentStatus, 'refunded');
        assert.equal(row.updatedAt, newer);
    });
});

test('线上版本更旧时按导入值覆盖，并以 bookingId 匹配而非 id', async () => {
    const dir = makeTempDir('update');
    const older = Date.parse('2026-09-01T00:00:00.000Z');
    // 库里这条订单的 id 与导出里的 id 不同，但仍应被正确匹配到
    const dbFile = await makeDb(dir, [dbRow({ id: 777, bookingId: 'b-101', status: 'pending', updatedAt: older })]);
    const jsonFile = writeExport(dir, [apiRow({ id: 101, status: 'confirmed', paymentStatus: 'paid' })]);

    const { res, report } = importAndReadReport(dir, [`--in=${jsonFile}`, `--db=${dbFile}`, '--apply']);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.equal(report.counts.update, 1);
    assert.equal(report.counts.insert, 0);

    await withDb(dbFile, async (db) => {
        const rows = await all(db, 'SELECT * FROM bookings');
        assert.equal(rows.length, 1, '不应新增行，只应更新已存在的那条');
        assert.equal(rows[0].id, 777, 'id 是本地自增产物，不该被导出值改写');
        assert.equal(rows[0].status, 'confirmed');
        assert.equal(rows[0].paymentStatus, 'paid');
        assert.equal(rows[0].paidAt, Date.parse('2026-09-13T02:00:00.000Z'));
    });
});

test('重复导入幂等：第二次跑不再新增也不再更新', async () => {
    const dir = makeTempDir('idempotent');
    const dbFile = await makeDb(dir);
    const jsonFile = writeExport(dir, [apiRow({ id: 101 }), apiRow({ id: 102 })]);

    const first = importAndReadReport(dir, [`--in=${jsonFile}`, `--db=${dbFile}`, '--apply']);
    assert.equal(first.res.status, 0, first.res.stderr || first.res.stdout);
    assert.equal(first.report.counts.insertedOk, 2);

    const snapshot = fs.readFileSync(dbFile);
    const second = importAndReadReport(dir, [`--in=${jsonFile}`, `--db=${dbFile}`, '--apply']);
    assert.equal(second.res.status, 0, second.res.stderr || second.res.stdout);
    assert.equal(second.report.counts.insert, 0);
    assert.equal(second.report.counts.update, 0);
    assert.equal(second.report.counts.stale, 2);
    assert.equal(second.report.counts.insertedOk ?? 0, 0);
    assert.deepEqual(fs.readFileSync(dbFile), snapshot, '第二次导入后库文件应与第一次完全一致');
});

test('导出 id 被别的订单占用时，改由 sqlite 分配 id 而不是让整行插入失败', async () => {
    const dir = makeTempDir('idclash');
    // id=101 已被另一条订单占用（跨快照 id 不可信的现实场景）
    const dbFile = await makeDb(dir, [dbRow({ id: 101, bookingId: 'b-other' })]);
    const jsonFile = writeExport(dir, [apiRow({ id: 101, bookingId: 'b-101' })]);

    const { res, report } = importAndReadReport(dir, [`--in=${jsonFile}`, `--db=${dbFile}`, '--apply']);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.equal(report.counts.conflict, 1, '应记录 id 冲突');
    assert.equal(report.counts.insertedOk, 1, '数据本身必须成功落库');
    assert.equal(report.counts.failed, 0, '不能因为 id 冲突就写入失败');

    await withDb(dbFile, async (db) => {
        const rows = await all(db, 'SELECT id, bookingId FROM bookings ORDER BY id');
        assert.equal(rows.length, 2);
        // 被占用的 id 不能被抢走
        assert.equal(rows.find((r) => r.id === 101).bookingId, 'b-other');
        const restored = rows.find((r) => r.bookingId === 'b-101');
        assert.ok(restored, '订单应已插入');
        assert.notEqual(restored.id, 101, '应换用新 id');
    });
});

test('写入后校正 sqlite_sequence，避免后续新订单重用已占用的 id', async () => {
    const dir = makeTempDir('sequence');
    const dbFile = await makeDb(dir, [dbRow({ id: 10, bookingId: 'b-10' })]);
    // 导出的这批订单 id 很大（事故前的存量），插入后序列必须跟上
    const jsonFile = writeExport(dir, [apiRow({ id: 5000, bookingId: 'b-5000' })]);

    const { res } = importAndReadReport(dir, [`--in=${jsonFile}`, `--db=${dbFile}`, '--apply']);
    assert.equal(res.status, 0, res.stderr || res.stdout);

    await withDb(dbFile, async (db) => {
        // 模拟服务恢复后插入一笔新订单（不指定 id）
        const after = await run(db, `INSERT INTO bookings (bookingId, wechatOpenId, bookingDate, timeSlot, travelMode, personCount, createdAt, updatedAt) VALUES ('b-new','o-x','2026-09-21','morning','scenicBus',1,1,1)`);
        assert.ok(after.lastID > 5000, `新订单应拿到 >5000 的 id，实际 ${after.lastID}`);
    });
});

test('库被旧进程占用（事故状态）时拒绝写入，并给出恢复指引', async () => {
    const dir = makeTempDir('locked');
    const dbFile = await makeDb(dir, [dbRow({ id: 10, bookingId: 'b-10' })]);
    const jsonFile = writeExport(dir, [apiRow({ id: 101 })]);

    // 复刻事故现场：另一条连接开着写事务且永不提交
    const holder = await openDb(dbFile, sqlite3.OPEN_READWRITE);
    await run(holder, 'PRAGMA busy_timeout = 1000');
    await run(holder, 'BEGIN IMMEDIATE');

    try {
        const { res } = importAndReadReport(dir, [`--in=${jsonFile}`, `--db=${dbFile}`, '--apply']);
        assert.notEqual(res.status, 0, '持锁时不应报告成功');
        assert.match(res.stderr, /无法获取写锁/);
        assert.match(res.stderr, /db-journal/, '应提示先存档 journal');
        assert.match(res.stderr, /重启/, '应提示重启进程');

        // 关键：拒绝写入时不能留下半截数据
        await withDb(dbFile, async (db) => {
            const [c] = await all(db, 'SELECT COUNT(*) AS c FROM bookings');
            assert.equal(c.c, 1, '被拒绝时不应写入任何行');
        });
    } finally {
        await run(holder, 'ROLLBACK').catch(() => {});
        await close(holder);
    }
});

test('字段与表结构对不上时中止，除非显式 --allow-shape-drift', async () => {
    const dir = makeTempDir('shape');
    const dbFile = await makeDb(dir);
    // 混进一个表里不存在的字段：说明 JSON 可能来自另一版本的服务或导错了库
    const jsonFile = writeExport(dir, [{ ...apiRow({ id: 101 }), totallyUnknownColumn: 'x' }]);

    const strict = importAndReadReport(dir, [`--in=${jsonFile}`, `--db=${dbFile}`, '--apply']);
    assert.notEqual(strict.res.status, 0);
    assert.match(strict.res.stderr, /字段与表结构对不上/);

    await withDb(dbFile, async (db) => {
        const [c] = await all(db, 'SELECT COUNT(*) AS c FROM bookings');
        assert.equal(c.c, 0, '中止时不应写入');
    });

    const lenient = importAndReadReport(dir, [`--in=${jsonFile}`, `--db=${dbFile}`, '--apply', '--allow-shape-drift']);
    assert.equal(lenient.res.status, 0, lenient.res.stderr || lenient.res.stdout);
    assert.equal(lenient.report.counts.insertedOk, 1);
});

test('备份：--apply 时默认产出可回滚的逻辑备份与原始副本', async () => {
    const dir = makeTempDir('backup');
    const dbFile = await makeDb(dir, [dbRow({ id: 10, bookingId: 'b-10' })]);
    const jsonFile = writeExport(dir, [apiRow({ id: 101 })]);

    const { res } = importAndReadReport(dir, [`--in=${jsonFile}`, `--db=${dbFile}`, '--apply']);
    assert.equal(res.status, 0, res.stderr || res.stdout);

    const files = fs.readdirSync(dir);
    const logical = files.find((f) => f.includes('.pre-import-'));
    assert.ok(logical, '缺少逻辑备份');
    const rawcopy = files.find((f) => f.includes('.rawcopy-'));
    assert.ok(rawcopy, '缺少原始副本');
    assert.ok(fs.statSync(path.join(dir, rawcopy)).size > 0, '原始副本是 0 字节');

    // 逻辑备份必须真的能用来回滚：非空、能独立打开、内容是「导入前」的状态。
    //
    // 这一组断言曾经缺失（只检查文件名里有没有 .pre-import-），于是 db.backup() 产出
    // 0 字节文件时测试照样全绿 —— 而那正好对应最坏的剧本：手册让用户用这份备份回滚，
    // 真出事时把生产库覆盖成一个空文件。node-sqlite3 的 backup() 是增量备份，
    // 回调只表示「已启动」，必须继续 step() 到 finished；现已改用 VACUUM INTO。
    const logicalPath = path.join(dir, logical);
    assert.ok(fs.statSync(logicalPath).size > 0, `逻辑备份是 0 字节：${logical}`);
    await withDb(logicalPath, async (db) => {
        const [row] = await all(db, 'SELECT COUNT(*) AS c FROM bookings');
        assert.equal(row.c, 1, '逻辑备份应恰好是导入前那 1 行');
        const rows = await all(db, 'SELECT id, bookingId FROM bookings');
        assert.equal(rows[0].bookingId, 'b-10', '逻辑备份里应是导入前的那行');
    });

    // 源库确实被写入了 —— 证明上面备份下来的确实是「改动前」
    await withDb(dbFile, async (db) => {
        const [row] = await all(db, 'SELECT COUNT(*) AS c FROM bookings');
        assert.equal(row.c, 2, '源库导入后应为 2 行');
    });
});

test('导入文件 sha256 对不上时拒绝写库', async () => {
    const dir = makeTempDir('sha');
    const dbFile = await makeDb(dir);
    const file = path.join(dir, 'bookings.json');
    // meta 里写一个错误的校验和，模拟文件在传输中被改动
    fs.writeFileSync(file, JSON.stringify({ meta: { sha256OfBookings: 'deadbeef' }, bookings: [apiRow()] }), 'utf8');

    const { res } = importAndReadReport(dir, [`--in=${file}`, `--db=${dbFile}`, '--apply']);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /校验失败/);
});

test('导出端到端：解析 curl 文件、按 pageSize 上限翻页、合并去重并落盘', async () => {
    const TOTAL = 250;
    const requests = [];
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        const page = Number(url.searchParams.get('page') || 1);
        const pageSize = Number(url.searchParams.get('pageSize') || 10);
        requests.push({ page, pageSize, adminKey: req.headers['x-admin-key'] });

        const start = (page - 1) * pageSize;
        const data = [];
        for (let i = start; i < Math.min(start + pageSize, TOTAL); i++) {
            data.push({ id: i + 1, bookingId: `b-${i + 1}`, createdAt: '2026-09-13T01:00:00.000Z', seat: i });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            data,
            pagination: { page, pageSize, total: TOTAL, totalPages: Math.ceil(TOTAL / pageSize) },
        }));
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
        const dir = makeTempDir('export');
        // 模仿 DevTools「Copy as cURL」的 bash 格式，含行尾续行符
        const curlFile = path.join(dir, 'curl.txt');
        fs.writeFileSync(
            curlFile,
            [
                `curl 'http://127.0.0.1:${port}/api/admin/bookings?page=1&pageSize=10' \\`,
                `  -H 'accept: application/json' \\`,
                `  -H 'x-admin-key: test-admin-key' \\`,
                `  -H ':authority: 127.0.0.1' \\`,
                `  --compressed`,
            ].join('\n'),
            'utf8',
        );

        const outDir = path.join(dir, 'out');
        const res = await runNodeAsync(
            [exportScript, `--curl=${curlFile}`, `--out-dir=${outDir}`, '--page-size=100', '--sleep=0'],
        );

        assert.equal(res.status, 0, res.stderr || res.stdout);
        assert.match(res.stdout, /总计|total = 250/);

        const saved = JSON.parse(fs.readFileSync(path.join(outDir, 'bookings.json'), 'utf8'));
        assert.equal(saved.bookings.length, TOTAL, '应集齐全部订单');
        assert.equal(saved.meta.totalReported, TOTAL);
        assert.equal(saved.meta.rowsExported, TOTAL);

        // 行数应等于页数 × pageSize 上限：250 条按 100 分 3 页
        assert.equal(requests.length, 3);
        assert.ok(requests.every((r) => r.pageSize === 100), 'pageSize 必须尊重接口上限');
        assert.ok(requests.every((r) => r.adminKey === 'test-admin-key'), '鉴权头必须原样带上');
        assert.deepEqual(requests.map((r) => r.page).sort((a, b) => a - b), [1, 2, 3]);

        // 逐条去重且无缺漏
        const ids = new Set(saved.bookings.map((b) => b.bookingId));
        assert.equal(ids.size, TOTAL);
        assert.equal(fs.readFileSync(path.join(outDir, 'bookings.jsonl'), 'utf8').trim().split('\n').length, TOTAL);

        // 校验和可用于事后核对文件是否被改动
        const crypto = require('node:crypto');
        const sha = crypto.createHash('sha256').update(JSON.stringify(saved.bookings), 'utf8').digest('hex');
        assert.equal(saved.meta.sha256OfBookings, sha);

        // 每页原始响应都应存档（事故取证）
        assert.equal(fs.readdirSync(path.join(outDir, 'raw')).length, 3);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test('导出端到端：接口连续失败时报错退出而不是产出残缺 JSON', async () => {
    const server = http.createServer((req, res) => {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end('<html>Bad Gateway</html>');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
        const dir = makeTempDir('exportfail');
        const outDir = path.join(dir, 'out');
        const res = await runNodeAsync(
            [exportScript, `--url=http://127.0.0.1:${port}/api/admin/bookings`, `--out-dir=${outDir}`, '--retries=1'],
        );

        assert.notEqual(res.status, 0, '失败时必须以非 0 退出');
        assert.match(res.stderr, /响应不是 JSON/);
        assert.equal(fs.existsSync(path.join(outDir, 'bookings.json')), false, '失败时不应产出看似完整的 JSON');
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});
