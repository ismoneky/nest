#!/usr/bin/env node
/**
 * 事故恢复：把导出的订单 JSON 写回线上 SQLite 数据文件。
 *
 * ── 它解决什么 ──────────────────────────────────────────────────────────
 * 2026-09-13 事故后，磁盘上的 prod.db 缺了一批只存在于旧进程连接内存里的写入。
 * 重启前已用 scripts/export-bookings-from-api.js 经 HTTP 把数据抢成 JSON；
 * 重启之后，用本脚本把这批数据补回 prod.db。
 * 详见 src/common/transaction-runner.ts 顶部注释。
 *
 * ── 设计上的几条硬原则 ──────────────────────────────────────────────────
 * 1. **默认 dry-run**。不加 --apply 绝不写库，只打印将要发生的增删改统计。
 * 2. **以 bookingId 为准，不看自增 id**。id 是本地产物，跨快照不可信（见 id 冲突处理）。
 * 3. **绝不覆盖更新的数据**。已存在的行只有 updatedAt 比导入值更新时才更新；
 *    相等或更旧一律跳过。这样脚本天然幂等，重跑、断点续跑都安全，
 *    也不会把导出之后线上新写入的状态回退掉。
 * 4. **单事务**。默认整批一个 BEGIN IMMEDIATE ... COMMIT，失败全量回滚；
 *    需要分段可加 --batch=N。
 * 5. **动库前先备份**，且备份分两份（逻辑一致 + 原始字节），理由见 backup() 注释。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 *   # 1) 先空跑，核对统计
 *   node scripts/import-bookings-to-db.js --in=recovery-export-xxx/bookings.json --db=data/prod.db
 *
 *   # 2) 确认无误后真正写库（自动备份）
 *   node scripts/import-bookings-to-db.js --in=... --db=data/prod.db --apply
 *
 * 选项：
 *   --in=<file>        导出的 bookings.json（必填）
 *   --db=<file>        SQLite 库路径，默认取环境变量 DATABASE_PATH，否则 data/prod.db
 *   --apply            真正写库（默认只读空跑）
 *   --backup           写库前备份（--apply 时默认开启；--no-backup 关闭）
 *   --batch=<n>        每 n 行提交一次（默认 0 = 整批一个事务）
 *   --table=<name>     目标表名，默认 bookings
 *   --report=<file>    报告输出路径，默认 import-report-<时间戳>.json
 *   --allow-shape-drift  当 JSON 字段与表结构对不上时继续（默认直接中止）
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3');

// ────────────────────────────── 参数 ──────────────────────────────

function parseArgs(argv) {
    const opts = {
        in: null,
        db: process.env.DATABASE_PATH || path.join('data', 'prod.db'),
        apply: false,
        backup: null, // null = 跟随 apply
        batch: 0,
        table: 'bookings',
        report: null,
        allowShapeDrift: false,
    };
    for (const arg of argv) {
        const eq = arg.indexOf('=');
        const key = eq === -1 ? arg : arg.slice(0, eq);
        const val = eq === -1 ? null : arg.slice(eq + 1);
        switch (key) {
            case '--in': opts.in = req(key, val); break;
            case '--db': opts.db = req(key, val); break;
            case '--table': opts.table = req(key, val); break;
            case '--report': opts.report = req(key, val); break;
            case '--batch': opts.batch = int(key, val, { min: 0 }); break;
            case '--apply': opts.apply = true; break;
            case '--backup': opts.backup = true; break;
            case '--no-backup': opts.backup = false; break;
            case '--allow-shape-drift': opts.allowShapeDrift = true; break;
            case '--help': case '-h': help(); process.exit(0); break;
            default: die(`未知参数 ${arg}（--help 查看用法）`);
        }
    }
    if (opts.backup === null) opts.backup = opts.apply;
    return opts;
}

function req(k, v) { if (v == null || v === '') die(`${k} 需要取值`); return v; }
function int(k, v, { min }) {
    const n = Number.parseInt(req(k, v), 10);
    if (!Number.isFinite(n) || n < min) die(`${k} 取值非法，期望 ≥${min} 的整数`);
    return n;
}
function die(msg) { console.error(`\n[导入中止] ${msg}\n`); process.exit(1); }
function help() {
    console.log(`
用法: node scripts/import-bookings-to-db.js --in=<bookings.json> [--db=<prod.db>] [--apply]

  --in=<file>         导出的 bookings.json（必填）
  --db=<file>         SQLite 库路径，默认 $DATABASE_PATH 或 data/prod.db
  --apply            真正写库（默认只空跑打印统计）
  --no-backup        跳过备份（不推荐）
  --batch=<n>        每 n 行提交一次，默认 0 = 整批一个事务
  --table=<name>     目标表，默认 bookings
  --report=<file>    报告路径
  --allow-shape-drift  字段与表结构对不上时继续（默认中止）
`);
}

// ────────────────────────────── sqlite 小工具 ──────────────────────────────

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
function get(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
}
function close(db) {
    return new Promise((resolve) => db.close(() => resolve()));
}
/**
 * 逻辑备份：用 VACUUM INTO 产出一份完整、可独立打开的库。
 *
 * **不要改用 node-sqlite3 的 db.backup()**。它是「增量备份」：回调只表示备份**已启动**，
 * 必须拿返回值继续 step() 到 finished 才算完成。把回调当完成用会产出 0 字节文件，
 * 而且那个未完成的备份会让连接连 close() 都失败（SQLITE_BUSY: unfinished backups）。
 * 这份备份是回滚用的最后防线 —— 0 字节等于把「可回滚」变成「覆盖成空库」。
 * VACUUM INTO 需要 SQLite ≥ 3.27（本机 3.44）。
 */
async function logicalBackup(db, dest, table) {
    fs.rmSync(dest, { force: true }); // VACUUM INTO 要求目标文件不存在
    await run(db, `VACUUM INTO '${String(dest).replace(/'/g, "''")}'`);

    const size = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
    if (size === 0) throw new Error(`逻辑备份产出 0 字节：${dest}`);

    // 独立打开副本核对「能打开 + 完整 + 行数一致」——备份不能只看文件是否存在
    const copy = await openDb(dest, sqlite3.OPEN_READONLY);
    try {
        await run(copy, 'PRAGMA busy_timeout = 5000');
        const chk = await get(copy, 'PRAGMA quick_check');
        const verdict = chk ? Object.values(chk)[0] : '?';
        if (String(verdict).toLowerCase() !== 'ok') throw new Error(`逻辑备份 quick_check = ${verdict}`);
        const srcRows = await get(db, `SELECT COUNT(*) AS c FROM ${quoteIdent(table)}`);
        const copyRows = await get(copy, `SELECT COUNT(*) AS c FROM ${quoteIdent(table)}`);
        if (!srcRows || !copyRows || srcRows.c !== copyRows.c) {
            throw new Error(`逻辑备份行数不一致：源 ${srcRows ? srcRows.c : '?'} / 副本 ${copyRows ? copyRows.c : '?'}`);
        }
        return { size, rows: copyRows.c };
    } finally {
        await close(copy);
    }
}

// ────────────────────────────── 类型归一化 ──────────────────────────────

/**
 * 把接口返回的 JSON 值还原成 SQLite 里该列真正的存储形态。
 *
 * 「直接把 JSON 塞回去」是这类恢复脚本最容易翻车的地方，原因是实体上挂了
 * timestamp.transformer：库里存的是毫秒整数，而 JSON 里是 ISO 字符串；
 * bookingDate 是 date 列存 'YYYY-MM-DD'；isFree 是 boolean 存 0/1。
 * 不做这层转换就会出现「导入成功但全是脏数据」，比导入失败更糟。
 *
 * @param {*} value       JSON 里的值
 * @param {string} type   PRAGMA table_info 给的声明类型
 * @param {string} col    列名（date 类语义要靠列名兜底）
 */
function normalizeValue(value, type, col) {
    const t = (type || '').toLowerCase();

    if (value === null || value === undefined) return null;

    // boolean 列：JSON 给 true/false，sqlite 存 1/0
    if (t.includes('bool')) {
        if (typeof value === 'boolean') return value ? 1 : 0;
        if (typeof value === 'number') return value ? 1 : 0;
        if (value === 'true' || value === '1') return 1;
        if (value === 'false' || value === '0') return 0;
        return value ? 1 : 0;
    }

    // date 列：只保留日期部分。已经是 'YYYY-MM-DD' 就原样保留（不重新 parse，
    // 避免把纯日期字符串拖进时区换算）；是 ISO 时间去用本地分量格式化，
    // 与 TypeORM 写入该列时 DateUtils.mixedDateToDateString 的语义保持一致。
    if (t === 'date' || t === 'datetime' || /date$/i.test(col)) {
        if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
        const d = value instanceof Date ? value : new Date(value);
        if (!Number.isNaN(d.getTime())) return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
        return String(value);
    }

    // 整数/数字列：ISO 字符串要转毫秒时间戳，数字原样，纯数字串转数字
    if (t.includes('int') || t.includes('real') || t.includes('numeric') || t.includes('decimal')) {
        if (typeof value === 'number') return value;
        if (typeof value === 'boolean') return value ? 1 : 0;
        if (typeof value === 'string') {
            if (/^-?\d+$/.test(value)) return Number(value);
            const d = new Date(value);
            if (!Number.isNaN(d.getTime())) return d.getTime(); // ISO → 毫秒，与 transformer 的 to() 一致
            return value;
        }
        return value;
    }

    // 其余按文本处理；对象/数组先序列化（passengers 在实体里就是 JSON 字符串）
    if (typeof value === 'object') return JSON.stringify(value);
    return value;
}

function p2(n) { return String(n).padStart(2, '0'); }

/** 取「版本号」，用于判断哪边更新。缺失时返回 null，调用方按「无法比较」处理。 */
function versionOf(row) {
    const v = row ? row.updatedAt : null;
    if (v == null) return null;
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && /^-?\d+$/.test(v)) return Number(v);
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.getTime();
}

// ────────────────────────────── 主流程 ──────────────────────────────

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (!opts.in) die('必须提供 --in=<bookings.json>');

    const inFile = path.resolve(opts.in);
    const dbFile = path.resolve(opts.db);
    if (!fs.existsSync(inFile)) die(`导入文件不存在：${inFile}`);
    if (!fs.existsSync(dbFile)) die(`数据库文件不存在：${dbFile}\n  线上应在后端目录下，例如 /app/backend/data/prod.db`);

    // ── 读输入 ──
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(inFile, 'utf8'));
    } catch (err) {
        die(`导入文件不是合法 JSON：${err.message}`);
    }
    const bookings = Array.isArray(raw) ? raw : raw.bookings;
    if (!Array.isArray(bookings) || bookings.length === 0) die('导入文件里没有 bookings 数组，或数组为空');

    console.log('=== 订单导入 ===');
    console.log(`  来源：${inFile}`);
    console.log(`  目标：${dbFile}`);
    console.log(`  条数：${bookings.length}`);
    if (raw.meta) {
        console.log(`  导出时间：${raw.meta.exportedAt}`);
        if (raw.meta.sha256OfBookings) {
            const actual = crypto.createHash('sha256').update(JSON.stringify(bookings), 'utf8').digest('hex');
            if (actual === raw.meta.sha256OfBookings) {
                console.log('  校验：sha256 与导出时一致 ✓');
            } else {
                console.error(`  [警告] 校验失败！导出时 sha256=${raw.meta.sha256OfBookings}，当前=${actual}`);
                console.error('  文件被改过或在传输中损坏，请重新确认来源后再导入。');
                if (opts.apply) die('校验失败时拒绝 --apply 写库');
            }
        }
    }
    console.log(`  模式：${opts.apply ? '★ 真实写库（--apply）' : '空跑（dry-run，不改动数据库）'}`);
    console.log('');

    // ── 环境预检（只读）──
    await preflight(dbFile, opts.table);

    const db = await openDb(dbFile, sqlite3.OPEN_READWRITE);
    try {
        await run(db, 'PRAGMA busy_timeout = 15000');
        // 确认可写：拿一次立即写锁再放掉。失败说明旧进程仍持有未提交事务。
        try {
            await run(db, 'BEGIN IMMEDIATE');
            await run(db, 'ROLLBACK');
        } catch (err) {
            die(
                `数据库当前无法获取写锁：${err.message}\n\n` +
                `  这正是事故状态：旧进程的连接上还挂着一个永不提交的开放事务。\n` +
                `  请按顺序处理：\n` +
                `    1) 先存档 data/ 下的 *.db-journal / *.db-wal（那是未落盘数据的最后线索）；\n` +
                `    2) 再重启服务进程（重启即丢失内存里的那批写入）；\n` +
                `    3) 然后重新运行本脚本导入。`,
            );
        }

        // ── 表结构 ──
        const cols = await all(db, `PRAGMA table_info(${quoteIdent(opts.table)})`);
        if (cols.length === 0) die(`库里没有表 ${opts.table}（schema 不对？）`);
        const byName = new Map(cols.map((c) => [c.name, c]));
        console.log(`  表 ${opts.table}：${cols.length} 列`);

        // ── 字段对齐检查 ──
        const jsonKeys = new Set();
        for (const r of bookings.slice(0, 200)) for (const k of Object.keys(r)) jsonKeys.add(k);
        const unknownKeys = [...jsonKeys].filter((k) => !byName.has(k));
        const missingRequired = cols
            .filter((c) => c.notnull && c.dflt_value === null && c.pk === 0 && !jsonKeys.has(c.name))
            .map((c) => c.name);
        if (unknownKeys.length) console.log(`  JSON 多出的字段（会被忽略）：${unknownKeys.join(', ')}`);
        if (missingRequired.length) console.log(`  表里 NOT NULL 且无默认值、JSON 里没有的列：${missingRequired.join(', ')}`);
        if ((unknownKeys.length || missingRequired.length) && !opts.allowShapeDrift) {
            die(
                '字段与表结构对不上，已中止（避免写入残缺行）。\n' +
                '  这通常说明：JSON 来自另一版本的服务，或导错了库/表。\n' +
                '  确认无误后，可加 --allow-shape-drift 强制继续。'
            );
        }
        console.log('');

        // ── 逐行决策 ──
        const plan = { insert: [], update: [], stale: [], conflict: [], bad: [] };
        const seenKeys = new Set();
        const omitId = new Set(); // 需要放弃导出 id、改由 sqlite 分配的行

        const holderOf = async (id) => {
            const r = await get(db, `SELECT bookingId FROM ${quoteIdent(opts.table)} WHERE id = ?`, [id]);
            return r ? String(r.bookingId) : null;
        };

        for (const row of bookings) {
            const key = row && row.bookingId ? String(row.bookingId) : null;
            if (!key) { plan.bad.push({ row, reason: '缺少 bookingId，无法作为主键匹配' }); continue; }
            if (seenKeys.has(key)) { plan.bad.push({ row, reason: `导入文件内 bookingId 重复：${key}` }); continue; }
            seenKeys.add(key);

            const existing = await get(db, `SELECT id, updatedAt FROM ${quoteIdent(opts.table)} WHERE bookingId = ?`, [key]);

            if (!existing) {
                // 新增前先看导出 id 是否已被别的订单占用：跨快照的 id 不可信，
                // 硬写会撞主键让整行插不进去，那就丢掉 id 让 sqlite 重新分配并留痕。
                if (row.id != null) {
                    const heldBy = await holderOf(row.id);
                    if (heldBy && heldBy !== key) {
                        plan.conflict.push({ key, wantId: row.id, heldBy, resolution: '放弃导出 id，按新 id 插入' });
                        omitId.add(key);
                    }
                }
                plan.insert.push(row);
                continue;
            }

            const incomingV = versionOf(row), existingV = versionOf(existing);
            if (incomingV == null || existingV == null) {
                // 版本号拿不到就没法判断谁更新，宁可不写也不猜
                plan.bad.push({ row, reason: 'updatedAt 无法解析，无法判断新旧，已跳过以免覆盖线上数据' });
                continue;
            }
            if (incomingV <= existingV) {
                plan.stale.push({ key, existingId: existing.id, incomingV, existingV });
                continue;
            }
            plan.update.push({ row, existingId: existing.id, incomingV, existingV });
        }

        console.log('=== 预演结果 ===');
        console.log(`  新增：${plan.insert.length}`);
        console.log(`  更新：${plan.update.length}（线上版本更旧，需被覆盖）`);
        console.log(`  跳过：${plan.stale.length}（线上版本相同或更新，保持不动）`);
        console.log(`  冲突：${plan.conflict.length}（导出 id 已被别的订单占用）`);
        console.log(`  异常：${plan.bad.length}`);
        console.log('');

        if (plan.bad.length) {
            console.error('  [警告] 有无法处理的行，示例：');
            for (const b of plan.bad.slice(0, 5)) {
                console.error(`    - ${b.reason}｜${JSON.stringify(b.row).slice(0, 160)}`);
            }
            console.error('');
        }

        if (!opts.apply) {
            const reportPath = writeReport(opts, { applied: false, inFile, dbFile, plan });
            console.log(`  报告：${reportPath}`);
            console.log('\n  这是空跑，数据库未被改动。确认上面的统计后加 --apply 真正写库。');
            return;
        }

        // ── 备份 ──
        if (opts.backup) await doBackup(db, dbFile, opts.table);

        // ── 写入 ──
        console.log('=== 开始写库 ===');
        const stats = { inserted: 0, updated: 0, skippedConcurrent: 0, errors: [] };
        const batchSize = opts.batch > 0 ? opts.batch : plan.insert.length + plan.update.length + 1;
        let pending = 0;
        let inTx = false;

        const beginTx = async () => { if (!inTx) { await run(db, 'BEGIN IMMEDIATE'); inTx = true; } };
        const commitTx = async () => { if (inTx) { await run(db, 'COMMIT'); inTx = false; } };

        await beginTx();

        // 插入用 ON CONFLICT(bookingId) DO NOTHING：服务若已重启并抢先插入了同一订单，
        // 这里只是让路，而不是把整批事务带崩。
        for (const row of plan.insert) {
            try {
                const { sql, params } = buildInsert(opts.table, row, byName, omitId.has(String(row.bookingId)));
                const res = await run(db, sql, params);
                if (res.changes === 0) stats.skippedConcurrent++;
                else stats.inserted++;
            } catch (err) {
                stats.errors.push({ kind: 'insert', bookingId: row.bookingId, error: err.message });
            }
            if (++pending >= batchSize) { await commitTx(); await beginTx(); pending = 0; }
        }

        for (const item of plan.update) {
            try {
                const { sql, params } = buildUpdate(opts.table, item.row, byName);
                const res = await run(db, sql, params);
                // changes=0 说明写入条件在事务里没再成立：期间有更新的版本落地了，让路是对的
                if (res.changes === 0) stats.skippedConcurrent++;
                else stats.updated++;
            } catch (err) {
                stats.errors.push({ kind: 'update', bookingId: item.row.bookingId, error: err.message });
            }
            if (++pending >= batchSize) { await commitTx(); await beginTx(); pending = 0; }
        }

        await commitTx();

        // ── 自增序列校正 ──
        // 显式写入过 id 之后，必须保证 sqlite_sequence 不小于表内最大 id，
        // 否则后续新订单可能分到已被占用的 id。
        const seqFixed = await fixSequence(db, opts.table);

        // ── 复核 ──
        const after = await get(db, `SELECT COUNT(*) AS c FROM ${quoteIdent(opts.table)}`);
        const sum = await get(db, `SELECT SUM(amount) AS s FROM ${quoteIdent(opts.table)}`);

        console.log(`  新增成功：${stats.inserted}`);
        console.log(`  更新成功：${stats.updated}`);
        if (stats.skippedConcurrent) {
            console.log(`  让路跳过：${stats.skippedConcurrent}（写入期间线上已有更新版本或已存在同一订单）`);
        }
        console.log(`  失败：${stats.errors.length}`);
        console.log(`  自增序列：${seqFixed}`);
        console.log(`  导入后总行数：${after.c}，amount 合计：${sum.s}`);
        if (stats.errors.length) {
            console.error('\n  [警告] 有写入失败的行，示例：');
            for (const e of stats.errors.slice(0, 5)) console.error(`    - ${e.kind} ${e.bookingId}：${e.error}`);
        }

        const reportPath = writeReport(opts, { applied: true, inFile, dbFile, plan, stats, after });
        console.log(`\n  报告：${reportPath}`);
        console.log('\n  完成。建议接着核对：');
        console.log('    · 管理端订单列表的「总数」是否与接口报告的总数一致；');
        console.log('    · 抽查若干笔已支付订单的 paymentStatus / paidAt / transactionId 是否正确。');
        if (stats.errors.length) process.exitCode = 2;
    } finally {
        await close(db);
    }
}

// ────────────────────────────── 预检 ──────────────────────────────

async function preflight(dbFile, table) {
    console.log('=== 环境预检 ===');

    // 归档文件的存在本身就是证据：非空 journal 说明有未提交事务
    for (const suffix of ['-journal', '-wal', '-shm']) {
        const f = dbFile + suffix;
        if (fs.existsSync(f)) {
            const st = fs.statSync(f);
            console.log(`  发现 ${path.basename(f)}（${st.size} 字节）`);
            if (suffix === '-journal' && st.size > 0) {
                console.log('    ↑ 非空 journal：磁盘上很可能还有一个未提交事务，导入前务必先备份它。');
            }
        }
    }

    const skipIntegrity = process.argv.includes('--skip-integrity');
    const db = await openDb(dbFile, sqlite3.OPEN_READONLY);
    try {
        await run(db, 'PRAGMA busy_timeout = 5000');
        const jm = await get(db, 'PRAGMA journal_mode');
        console.log(`  journal_mode = ${jm ? Object.values(jm)[0] : '?'}`);
        const t = await get(db, `SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [table]);
        console.log(`  表 ${table}：${t ? '存在' : '不存在 ← 要小心'}`);
        if (!skipIntegrity) {
            const chk = await get(db, 'PRAGMA quick_check');
            const v = chk ? Object.values(chk)[0] : '?';
            console.log(`  quick_check = ${v}`);
            if (String(v).toLowerCase() !== 'ok') {
                console.log('    ↑ 库文件已有损坏，导入前请保留一份原始副本（本脚本的备份是逻辑备份，可能无法复制损坏页）。');
            }
        }
    } catch (err) {
        console.log(`  只读预检失败：${err.message}（继续尝试主流程）`);
    } finally {
        await close(db);
    }
    console.log('');
}

// ────────────────────────────── 备份 ──────────────────────────────

/**
 * 备份分两份，用途不同，缺一不可：
 *  · VACUUM INTO → 一份**逻辑一致**的库，导入失败时用它回滚。
 *    注意：它只包含已提交的数据；内存里那批未提交写入本来就不在里面。
 *  · 原始字节副本 + journal/wal → **取证**用。未提交事务的页可能还在 journal 里，
 *    将来若要做更深的恢复（或追责），这份原始现场是唯一凭据。
 */
async function doBackup(db, dbFile, table) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const logical = `${dbFile}.pre-import-${ts}`;
    const rawCopy = `${dbFile}.rawcopy-${ts}`;

    console.log('=== 备份 ===');
    const info = await logicalBackup(db, logical, table);
    console.log(`  逻辑备份：${logical}（${info.size} 字节 / ${info.rows} 行，已独立打开校验 quick_check=ok）`);

    fs.copyFileSync(dbFile, rawCopy);
    console.log(`  原始副本：${rawCopy}（${fs.statSync(rawCopy).size} 字节）`);

    for (const suffix of ['-journal', '-wal', '-shm']) {
        const f = dbFile + suffix;
        if (!fs.existsSync(f)) continue;
        const dest = `${rawCopy}${suffix}`;
        fs.copyFileSync(f, dest);
        const sha = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
        console.log(`  归档副本：${dest}（sha256 ${sha.slice(0, 16)}…）`);
    }
    console.log(`  回滚方式：停服务后把 ${path.basename(logical)} 覆盖回 ${path.basename(dbFile)}`);
    console.log('');
}

// ────────────────────────────── SQL 构造 ──────────────────────────────

function quoteIdent(name) {
    return `"${String(name).replace(/"/g, '""')}"`;
}

/** 只取 JSON 里有、且表里也有的列 */
function usableColumns(table, row, byName) {
    const names = [];
    for (const k of Object.keys(row)) {
        if (byName.has(k)) names.push(k);
    }
    return names;
}

function buildInsert(table, row, byName, omitId) {
    const cols = usableColumns(table, row, byName).filter((c) => !(omitId && c === 'id'));
    const params = cols.map((c) => normalizeValue(row[c], byName.get(c).type, c));
    const sql =
        `INSERT INTO ${quoteIdent(table)} (${cols.map(quoteIdent).join(', ')}) ` +
        `VALUES (${cols.map(() => '?').join(', ')}) ` +
        `ON CONFLICT(bookingId) DO NOTHING`;
    return { sql, params };
}

/**
 * 更新：只写 JSON 里出现过的列，并把版本判断放进 WHERE，让「线上是否已有更新版本」
 * 在事务里重新裁决一次 —— 预演与实际写入之间可能存在竞态（服务刚好重启并写入）。
 * 显式排除 id —— id 是本地自增产物，绝不能跟着数据一起搬（否则会撞掉别人的行）。
 */
function buildUpdate(table, row, byName) {
    const cols = usableColumns(table, row, byName).filter((c) => c !== 'id');
    const params = cols.map((c) => normalizeValue(row[c], byName.get(c).type, c));
    const incomingV = versionOf(row);
    params.push(row.bookingId, incomingV);
    const sql =
        `UPDATE ${quoteIdent(table)} SET ${cols.map((c) => `${quoteIdent(c)} = ?`).join(', ')} ` +
        `WHERE bookingId = ? AND (updatedAt IS NULL OR updatedAt <= ?)`;
    return { sql, params };
}

/** 校正 AUTOINCREMENT 序列，避免后续新订单重用已占用的 id */
async function fixSequence(db, table) {
    try {
        const hasSeq = await get(db, `SELECT name FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'`);
        if (!hasSeq) return '无 sqlite_sequence（表未用 AUTOINCREMENT），跳过';
        const maxRow = await get(db, `SELECT MAX(id) AS m FROM ${quoteIdent(table)}`);
        const maxId = maxRow && maxRow.m ? maxRow.m : 0;
        const cur = await get(db, `SELECT seq FROM sqlite_sequence WHERE name = ?`, [table]);
        if (!cur) {
            if (maxId > 0) await run(db, `INSERT INTO sqlite_sequence(name, seq) VALUES (?, ?)`, [table, maxId]);
            return `已初始化 seq=${maxId}`;
        }
        if (Number(cur.seq) < Number(maxId)) {
            await run(db, `UPDATE sqlite_sequence SET seq = ? WHERE name = ?`, [maxId, table]);
            return `已从 ${cur.seq} 提升到 ${maxId}`;
        }
        return `无需调整（seq=${cur.seq} ≥ max(id)=${maxId}）`;
    } catch (err) {
        return `校正失败（不致命，但请留意）：${err.message}`;
    }
}

// ────────────────────────────── 报告 ──────────────────────────────

const REPORT_CAP = 200;

function writeReport(opts, data) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.resolve(opts.report || `import-report-${ts}.json`);
    const { plan } = data;
    const report = {
        generatedAt: new Date().toISOString(),
        applied: data.applied,
        input: data.inFile,
        database: data.dbFile,
        table: opts.table,
        counts: {
            insert: plan.insert.length,
            update: plan.update.length,
            stale: plan.stale.length,
            conflict: plan.conflict.length,
            bad: plan.bad.length,
            ...(data.stats ? {
                insertedOk: data.stats.inserted,
                updatedOk: data.stats.updated,
                skippedConcurrent: data.stats.skippedConcurrent,
                failed: data.stats.errors.length,
            } : {}),
        },
        after: data.after || null,
        // 明细截断保存，避免 2 万条全量刷进报告
        details: {
            insertBookingIds: plan.insert.slice(0, REPORT_CAP).map((r) => r.bookingId),
            updatedBookingIds: plan.update.slice(0, REPORT_CAP).map((r) => r.row.bookingId),
            stale: plan.stale.slice(0, REPORT_CAP),
            conflict: plan.conflict.slice(0, REPORT_CAP),
            bad: plan.bad.slice(0, REPORT_CAP).map((b) => ({ reason: b.reason, bookingId: b.row && b.row.bookingId })),
            errors: data.stats ? data.stats.errors.slice(0, REPORT_CAP) : [],
        },
        truncatedAt: REPORT_CAP,
    };
    fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');
    return file;
}

main().catch((err) => {
    console.error(`\n[导入异常] ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
});
