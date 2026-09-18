#!/usr/bin/env node
/**
 * 订单 JSON → SQL 文本生成器（事故恢复用）。
 *
 * ── 这个脚本不碰数据库 ──────────────────────────────────────────────────
 * 它只做一件事：读 JSON 文件、写 .sql 文本文件。不开 sqlite 连接、不执行任何 SQL、
 * 不读 prod.db。真正写库由你自己执行：
 *
 *     sqlite3 data/prod.db < import.sql
 *
 * 好处是 SQL 全文可审、可 diff、可回滚，工具链里没有任何一步会「背着你」动生产库。
 *
 * ── 为什么不用管理端的「导出 Excel」做数据源 ────────────────────────────
 * 那个导出（src/modules/admin/admin.service.ts 的 exportBookingsToBuffer）是有损的：
 *   · passengers 被拍平成 "1.张三 138… 110…" 文本，JSON 结构没了；
 *   · amount 除以 100 变成元的字符串；
 *   · timeSlot/status/travelMode/vehicleType 被翻译成中文标签；
 *   · 完全没有 wechatOpenId / paymentStatus / refundStatus / isFree / remarks /
 *     updatedAt / refundedAt / paymentExpiredAt / reconcile* 等字段。
 * 用它恢复出来的订单没有 openid，用户在小程序里看不到自己的单，支付状态也全丢。
 * 所以数据源必须是 GET /admin/bookings 的 **JSON**。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 *   node scripts/bookings-to-sql.js --in=page-*.json --out-dir=sql-out
 *   node scripts/bookings-to-sql.js --in=bookings.json --out-dir=sql-out --mode=upsert
 *
 * 输入（自动识别结构，可传多个文件合并）：
 *   · 接口原始响应   { success, data: [...], pagination: {...} }
 *   · 已合并文件     { meta, bookings: [...] }
 *   · 裸数组         [ {...}, {...} ]
 *   · JSONL          每行一条
 *
 * 产出（三份，职责分开）：
 *   precheck.sql   只读检查：条数、有多少 bookingId 已存在、max(id)、sequence、完整性。
 *                  **先跑这个**，确认干净再动 import.sql。
 *   import.sql     BEGIN IMMEDIATE + INSERT + sequence 校正 + COMMIT。
 *   rollback.sql   删掉本次导入的那些 bookingId，用来撤销。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ────────────────────────────── 表结构 ──────────────────────────────
// 与 src/entities/booking.entity.ts 对齐。本脚本不连库，所以列类型写死在这里；
// 若线上表结构有出入，用 --schema-file 传 `sqlite3 data/prod.db ".schema bookings"` 的结果覆盖。
// 归一化规则来自实体上的 timestamp.transformer 与列类型声明。

/** 毫秒 epoch 整数（实体上挂了 timestampTransformer，JSON 里是 ISO 字符串） */
const MS_TIMESTAMP_COLS = ['paidAt', 'refundedAt', 'paymentExpiredAt', 'createdAt', 'updatedAt'];
/** 本来就是数字的整数列（无 transformer，JSON 里已是数字） */
const PLAIN_INT_COLS = ['personCount', 'amount', 'reconcileAttempts', 'reconcileNextAt', 'reconcileLastAt'];
const BOOL_COLS = ['isFree'];
const DATE_COLS = ['bookingDate'];

/** 期望的表列（顺序即 INSERT 的列顺序，id 由 sqlite 分配故不在其中） */
const TABLE_COLUMNS = [
    'bookingId', 'wechatOpenId', 'passengers', 'name', 'phone', 'idCard',
    'bookingDate', 'timeSlot', 'travelMode', 'licensePlate', 'vehicleType',
    'tourGroupName', 'tourOrderNumber', 'personCount', 'remarks', 'isFree', 'freeReason',
    'status', 'paymentStatus', 'refundStatus', 'amount',
    'transactionId', 'outTradeNo', 'outRefundNo',
    'paidAt', 'refundedAt', 'paymentExpiredAt',
    'reconcileKind', 'reconcileNextAt', 'reconcileAttempts', 'reconcileLastAt', 'reconcileLastErrorCode',
    'createdAt', 'updatedAt',
];

const DEFAULT_TABLE = 'bookings';

// ────────────────────────────── 参数 ──────────────────────────────

function parseArgs(argv) {
    const opts = {
        inputs: [],
        outDir: 'sql-out',
        table: DEFAULT_TABLE,
        mode: 'insert',       // insert | upsert
        hexStrings: false,
        keepId: false,
        noTransaction: false,
        schemaFile: null,
        versionCol: 'updatedAt',
    };
    for (const arg of argv) {
        const eq = arg.indexOf('=');
        const key = eq === -1 ? arg : arg.slice(0, eq);
        const val = eq === -1 ? null : arg.slice(eq + 1);
        switch (key) {
            case '--in': opts.inputs.push(req(key, val)); break;
            case '--out-dir': opts.outDir = req(key, val); break;
            case '--table': opts.table = req(key, val); break;
            case '--mode':
                opts.mode = req(key, val);
                if (!['insert', 'upsert'].includes(opts.mode)) die(`--mode 只能是 insert 或 upsert，实际「${opts.mode}」`);
                break;
            case '--hex-strings': opts.hexStrings = true; break;
            case '--keep-id': opts.keepId = true; break;
            case '--no-transaction': opts.noTransaction = true; break;
            case '--schema-file': opts.schemaFile = req(key, val); break;
            case '--version-col': opts.versionCol = req(key, val); break;
            case '--help': case '-h': help(); process.exit(0); break;
            default: die(`未知参数 ${arg}（--help 查看用法）`);
        }
    }
    return opts;
}

function req(k, v) { if (v == null || v === '') die(`${k} 需要取值`); return v; }
function die(msg) { console.error(`\n[生成中止] ${msg}\n`); process.exit(1); }
function help() {
    console.log(`
用法: node scripts/bookings-to-sql.js --in=<json...> [--out-dir=sql-out] [选项]

本脚本不连数据库，只把 JSON 转成 .sql 文本；写库由你自己执行
  sqlite3 data/prod.db < sql-out/import.sql

  --in=<file>         输入 JSON，可重复或用通配符（page-*.json）
  --out-dir=<dir>     输出目录，默认 sql-out
  --table=<name>      目标表名，默认 bookings
  --mode=insert       纯 INSERT（默认）。重复 bookingId 会让整批事务回滚，天然防重复导入
  --mode=upsert       INSERT ... ON CONFLICT(bookingId) DO UPDATE，可重复执行
  --keep-id           保留导出里的自增 id（默认丢弃，由 sqlite 重新分配，避免主键冲突）
  --hex-strings       文本值用 X'…' 十六进制字面量输出，转义绝对安全但不可读
  --no-transaction    不包 BEGIN/COMMIT（不推荐）
  --schema-file=<f>   用真实表结构覆盖内置列定义（sqlite3 prod.db ".schema bookings"）
`);
}

// ────────────────────────────── 输入 ──────────────────────────────

function expandInputs(patterns) {
    const files = [];
    for (const p of patterns) {
        if (p.includes('*') || p.includes('?')) {
            const dir = path.dirname(p);
            const base = path.basename(p);
            const re = new RegExp('^' + base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
            const found = fs.readdirSync(dir === '' ? '.' : dir)
                .filter((f) => re.test(f))
                .sort()
                .map((f) => path.join(dir === '' ? '.' : dir, f));
            if (found.length === 0) die(`通配符没匹配到文件：${p}`);
            files.push(...found);
        } else {
            if (!fs.existsSync(p)) die(`输入文件不存在：${p}`);
            files.push(p);
        }
    }
    return files;
}

/** 从任意一种输入结构里掏出订单数组 */
function extractRows(text, file) {
    const trimmed = text.trim();
    if (trimmed === '') return [];

    // JSONL：按行解析
    if (trimmed[0] !== '{' && trimmed[0] !== '[') {
        return trimmed.split(/\r?\n/).filter((l) => l.trim()).map((l, i) => {
            try {
                return JSON.parse(l);
            } catch (err) {
                die(`${file} 第 ${i + 1} 行不是合法 JSON：${err.message}`);
            }
        });
    }

    let parsed;
    try {
        parsed = JSON.parse(trimmed);
    } catch (err) {
        // 也可能是 JSONL（首行以 { 开头但整体不是 JSON）
        const lines = trimmed.split(/\r?\n/).filter((l) => l.trim());
        if (lines.length > 1) {
            return lines.map((l, i) => {
                try { return JSON.parse(l); } catch (e2) { die(`${file} 第 ${i + 1} 行不是合法 JSON：${e2.message}`); }
            });
        }
        die(`${file} 不是合法 JSON：${err.message}`);
    }

    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.bookings)) return parsed.bookings;  // 已合并格式
    if (Array.isArray(parsed.data)) return parsed.data;          // 接口原始响应
    if (Array.isArray(parsed.rows)) return parsed.rows;
    die(`${file} 里找不到订单数组（支持 data / bookings / rows / 裸数组 / JSONL）`);
}

function loadRows(files) {
    const byKey = new Map();
    const stats = [];
    let duplicateCount = 0;
    const totalsReported = [];

    for (const file of files) {
        const text = fs.readFileSync(file, 'utf8');
        // 顺便记录接口报告的 total，方便核对完整性
        try {
            const probe = JSON.parse(text);
            if (probe && probe.pagination && typeof probe.pagination.total === 'number') totalsReported.push(probe.pagination.total);
        } catch { /* JSONL 或裸数组，忽略 */ }

        const rows = extractRows(text, file);
        let added = 0;
        for (const row of rows) {
            const key = row && row.bookingId ? `bid:${row.bookingId}` : (row && row.id != null ? `id:${row.id}` : `sha:${crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex')}`);
            if (byKey.has(key)) { duplicateCount++; continue; }
            byKey.set(key, row);
            added++;
        }
        stats.push({ file: path.basename(file), rows: rows.length, added });
    }

    return { rows: [...byKey.values()], stats, duplicateCount, totalsReported };
}

// ────────────────────────────── 值归一化 ──────────────────────────────

/**
 * 把接口 JSON 里的值还原成该列真正的存储形态。
 *
 * 这一步不能省：实体挂了 timestamp.transformer，库里存毫秒整数而 JSON 里是 ISO 字符串；
 * bookingDate 是 date 列存 'YYYY-MM-DD'；isFree 是 boolean 存 0/1。
 * 直接把 JSON 值塞进 INSERT，会写出「导入成功但全是脏数据」——比导入失败更糟，
 * 因为 TypeORM 读回来时 new Date('2026-09-13T02:00:00.000Z') 之类还能歪打正着，
 * 而 '2026-09-20T00:00:00.000Z' 存进 date 列则是彻底的脏数据。
 */
function normalizeValue(value, col) {
    if (value === null || value === undefined) return null;

    if (BOOL_COLS.includes(col)) {
        if (typeof value === 'boolean') return value ? 1 : 0;
        if (typeof value === 'number') return value ? 1 : 0;
        if (value === 'true' || value === '1') return 1;
        if (value === 'false' || value === '0') return 0;
        return value ? 1 : 0;
    }

    if (DATE_COLS.includes(col)) {
        // 已经是纯日期就原样保留，不重新 parse，避免把日期串拖进时区换算
        if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
        const d = value instanceof Date ? value : new Date(value);
        if (!Number.isNaN(d.getTime())) return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
        return String(value);
    }

    if (MS_TIMESTAMP_COLS.includes(col)) {
        if (typeof value === 'number') return value;
        if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
        const t = new Date(value).getTime();
        if (Number.isNaN(t)) throw new Error(`列 ${col} 的时间值无法解析：${JSON.stringify(value)}`);
        return t; // 与 timestampTransformer.to() 的 getTime() 完全一致
    }

    if (PLAIN_INT_COLS.includes(col)) {
        if (typeof value === 'number') return value;
        if (typeof value === 'boolean') return value ? 1 : 0;
        if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
        return value;
    }

    // 其余按文本；对象/数组序列化（passengers 在实体里本就是 JSON 字符串）
    if (typeof value === 'object') return JSON.stringify(value);
    return value;
}

function p2(n) { return String(n).padStart(2, '0'); }

// ────────────────────────────── SQL 字面量 ──────────────────────────────

function sqlLiteral(value, hexStrings) {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error(`数值非法：${value}`);
        return String(value);
    }
    if (typeof value === 'boolean') return value ? '1' : '0';
    const s = String(value);
    if (hexStrings) {
        // X'…' 是 BLOB，必须 CAST 回 TEXT，否则 TypeORM 读出来是 Buffer
        return `CAST(X'${Buffer.from(s, 'utf8').toString('hex')}' AS TEXT)`;
    }
    return `'${s.replace(/'/g, "''")}'`;
}

function quoteIdent(name) { return `"${String(name).replace(/"/g, '""')}"`; }

// ────────────────────────────── 生成 ──────────────────────────────

function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.inputs.length === 0) die('必须用 --in=<json> 指定输入文件');

    const files = expandInputs(opts.inputs);
    const { rows, stats, duplicateCount, totalsReported } = loadRows(files);
    if (rows.length === 0) die('输入里没有订单数据');

    // 可选的表结构覆盖
    let columns = TABLE_COLUMNS;
    if (opts.schemaFile) {
        if (!fs.existsSync(opts.schemaFile)) die(`--schema-file 不存在：${opts.schemaFile}`);
        const ddl = fs.readFileSync(opts.schemaFile, 'utf8');
        const found = [...ddl.matchAll(/"([^"]+)"\s+[a-z]/gi)].map((m) => m[1]);
        if (found.length === 0) die('--schema-file 里解析不出列名，请确认内容是 CREATE TABLE 语句');
        columns = found.filter((c) => c !== 'id');
        console.log(`  用 --schema-file 覆盖列定义：${columns.length} 列`);
    }

    const table = opts.table;
    const tableIdent = quoteIdent(table);
    const useId = opts.keepId;
    const allColumns = useId ? ['id', ...columns] : columns;

    console.log('=== 生成 SQL ===');
    console.log(`  输入：${files.length} 个文件`);
    for (const s of stats) console.log(`    ${s.file}：${s.rows} 条 → 采纳 ${s.added} 条`);
    if (duplicateCount) console.log(`  去重：丢弃 ${duplicateCount} 条重复 bookingId`);
    console.log(`  合计：${rows.length} 条`);
    if (totalsReported.length) {
        const uniq = [...new Set(totalsReported)];
        console.log(`  接口报告的 total：${uniq.join(' / ')}${uniq.length > 1 ? '  ← 多个值不一致，说明导出期间数据在动' : ''}`);
        if (uniq.length === 1 && uniq[0] !== rows.length) {
            console.log(`  [注意] 采纳条数 ${rows.length} ≠ 接口 total ${uniq[0]}，请先查清差在哪，再执行 import.sql`);
        }
    }

    // ── 逐行生成 ──
    const insertStatements = [];
    const skipped = [];
    const usedColumns = new Set();

    for (const row of rows) {
        const cols = allColumns.filter((c) => (c === 'id' ? row.id != null : row[c] !== undefined));
        if (!cols.includes('bookingId')) { skipped.push({ row, reason: '缺少 bookingId（唯一键，必需）' }); continue; }
        // NOT NULL 且无默认值的列必须给值，否则 INSERT 会在库里报错
        const required = ['wechatOpenId', 'bookingDate', 'timeSlot', 'travelMode', 'personCount', 'createdAt', 'updatedAt'];
        const missing = required.filter((c) => !cols.includes(c));
        if (missing.length) { skipped.push({ row, reason: `缺少必填列 ${missing.join(', ')}` }); continue; }

        let values;
        try {
            values = cols.map((c) => sqlLiteral(normalizeValue(row[c], c), opts.hexStrings));
        } catch (err) {
            skipped.push({ row, reason: err.message });
            continue;
        }
        cols.forEach((c) => usedColumns.add(c));

        const colList = cols.map(quoteIdent).join(', ');
        let stmt = `INSERT INTO ${tableIdent} (${colList}) VALUES (${values.join(', ')})`;

        if (opts.mode === 'upsert') {
            const updatable = cols.filter((c) => c !== 'bookingId' && c !== 'id');
            const v = opts.versionCol;
            stmt += `\n  ON CONFLICT(bookingId) DO UPDATE SET ${updatable.map((c) => `${quoteIdent(c)} = excluded.${quoteIdent(c)}`).join(', ')}`;
            // 只在导入值更新时才覆盖，避免回退线上更新的数据
            if (cols.includes(v)) stmt += `\n  WHERE excluded.${quoteIdent(v)} > ${tableIdent}.${quoteIdent(v)}`;
        } else {
            // 纯 INSERT 是天然的防重复闸门：撞上已存在的 bookingId，唯一索引报错，
            // 整批事务随之回滚，不会留下半截数据。
            stmt += ';';
        }
        insertStatements.push(stmt);
    }

    if (skipped.length) {
        console.log(`\n  [警告] 跳过 ${skipped.length} 条无法生成的行：`);
        for (const s of skipped.slice(0, 5)) {
            console.log(`    - ${s.reason}｜${JSON.stringify(s.row).slice(0, 120)}`);
        }
        console.log('  这些行不会出现在 import.sql 里，请在执行前先决定怎么处理。');
    }

    const notSeen = columns.filter((c) => !usedColumns.has(c));
    if (notSeen.length) console.log(`\n  输入里没有的列（走库默认值 / 保持 NULL）：${notSeen.join(', ')}`);

    // ── import.sql ──
    const importedAt = new Date().toISOString();
    const ids = rows.map((r) => r && r.bookingId).filter(Boolean);
    const header = [
        `-- 订单恢复导入（自动生成，勿手改）`,
        `-- 生成时间：${importedAt}`,
        `-- 目标表：${table}`,
        `-- 条数：${insertStatements.length}${skipped.length ? `（另有 ${skipped.length} 条被跳过，未包含在内）` : ''}`,
        `-- 模式：${opts.mode}${useId ? '（保留自增 id）' : '（不写 id，由 sqlite 分配）'}`,
        `-- 来源：${files.map((f) => path.basename(f)).join(', ')}`,
        `--`,
        `-- 执行：sqlite3 data/prod.db < import.sql`,
        `-- 执行前请先跑 precheck.sql 确认没有已存在的 bookingId。`,
        `-- 回滚：sqlite3 data/prod.db < rollback.sql`,
        '',
    ].join('\n');

    const sequenceFix = [
        '',
        '-- 自增序列校正：本次若显式写过 id，必须保证 sqlite_sequence 不小于表内最大 id，',
        '-- 否则后续新订单可能分到已被占用的 id。',
        `UPDATE sqlite_sequence SET seq = (SELECT MAX(id) FROM ${tableIdent})`,
        `  WHERE name = '${table.replace(/'/g, "''")}' AND seq < (SELECT MAX(id) FROM ${tableIdent});`,
        '',
        `-- 导入后自检：应等于 ${insertStatements.length}`,
        `SELECT '本次导入条数核对' AS check_name, COUNT(*) AS inserted_now`,
        `  FROM ${tableIdent} WHERE bookingId IN (`,
        ids.slice(0, 500).map((i) => `    ${sqlLiteral(i, false)}`).join(',\n'),
        ids.length > 500 ? `    -- … 其余 ${ids.length - 500} 条见 precheck.sql 的 id 清单` : '',
        '  );',
        '',
    ].filter((l) => l !== '').join('\n');

    const body = insertStatements.join('\n');
    const importSql = opts.noTransaction
        ? `${header}\n${body}\n${sequenceFix}\n`
        : `${header}\nPRAGMA foreign_keys = OFF;\n\nBEGIN IMMEDIATE;\n\n${body}\n\nCOMMIT;\n${sequenceFix}\n`;

    // ── precheck.sql（只读）──
    const idValues = ids.map((i) => `  (${sqlLiteral(i, false)})`).join(',\n');
    const precheckSql = `-- 导入前检查（只读，不会改动任何数据）
-- 生成时间：${importedAt}   目标表：${table}   预期导入：${insertStatements.length} 条
--
-- 执行：sqlite3 data/prod.db < precheck.sql
-- 特别注意第 2 项：expected_but_already_exists 必须是 0。
-- 不为 0 说明库里的订单比预期多，先用 --mode=upsert 重新生成，
-- 或者查清楚这些 bookingId 为什么已在库中，再决定要不要导入。

.print '=== 1. 当前表内总行数 ==='
SELECT COUNT(*) AS rows_now FROM ${tableIdent};

.print ''
.print '=== 2. 本次要导入的 bookingId 里，有多少已在库中（必须为 0）==='
CREATE TEMP TABLE _expected (bookingId TEXT PRIMARY KEY);
INSERT INTO _expected (bookingId) VALUES
${idValues};
SELECT COUNT(*) AS expected_but_already_exists
  FROM ${tableIdent} b JOIN _expected e ON e.bookingId = b.bookingId;
.print '-- 若上面不为 0，列出前 20 条：'
SELECT b.bookingId, b.id, b.status, b.paymentStatus, b.updatedAt
  FROM ${tableIdent} b JOIN _expected e ON e.bookingId = b.bookingId
 LIMIT 20;

.print ''
.print '=== 3. 自增序列与当前最大 id ==='
SELECT (SELECT MAX(id) FROM ${tableIdent}) AS max_id,
       (SELECT seq FROM sqlite_sequence WHERE name = '${table.replace(/'/g, "''")}') AS seq;

.print ''
.print '=== 4. 库文件完整性（大库会慢，可跳过）==='
-- PRAGMA quick_check;

.print ''
.print '=== 5. 表结构与本次导入列对比 ==='
PRAGMA table_info(${tableIdent});
`;

    // ── rollback.sql ──
    const rollbackSql = `-- 回滚：删掉本次导入涉及的 bookingId
-- 生成时间：${importedAt}
-- 执行：sqlite3 data/prod.db < rollback.sql
--
-- 注意：这只删「本次导入清单里」的订单。如果同一批 bookingId 里有原本就存在于库中的行
-- （即 precheck.sql 第 2 项不为 0），那些行也会被一起删掉，请先确认清楚。
-- 更稳妥的撤销方式是导入前备份：cp data/prod.db data/prod.db.bak-$(date +%Y%m%d-%H%M%S)

BEGIN IMMEDIATE;

DELETE FROM ${tableIdent} WHERE bookingId IN (
${ids.map((i) => `  ${sqlLiteral(i, false)}`).join(',\n')}
);

SELECT changes() AS deleted_rows;

COMMIT;
`;

    // ── 落盘 ──
    const outDir = path.resolve(opts.outDir);
    fs.mkdirSync(outDir, { recursive: true });
    const importPath = path.join(outDir, 'import.sql');
    const precheckPath = path.join(outDir, 'precheck.sql');
    const rollbackPath = path.join(outDir, 'rollback.sql');
    fs.writeFileSync(importPath, importSql, 'utf8');
    fs.writeFileSync(precheckPath, precheckSql, 'utf8');
    fs.writeFileSync(rollbackPath, rollbackSql, 'utf8');

    // 清单文件，便于事后核对与复现
    const manifest = {
        generatedAt: importedAt,
        table,
        mode: opts.mode,
        keepId: useId,
        inputs: files.map((f) => path.basename(f)),
        rowsIn: rows.length,
        statements: insertStatements.length,
        skipped: skipped.map((s) => ({ reason: s.reason, bookingId: s.row && s.row.bookingId })),
        columnsUsed: [...usedColumns],
        columnsAbsent: notSeen,
        bookingIds: ids.length <= 5000 ? ids : undefined,
        sha256OfImportSql: crypto.createHash('sha256').update(importSql, 'utf8').digest('hex'),
        files: { import: importPath, precheck: precheckPath, rollback: rollbackPath },
    };
    fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

    // ── 汇总 ──
    const size = (p) => `${(fs.statSync(p).size / 1024 / 1024).toFixed(1)} MB`;
    console.log('\n=== 产出 ===');
    console.log(`  ${precheckPath}  （只读检查，先跑这个）`);
    console.log(`  ${importPath}    ${size(importPath)}`);
    console.log(`  ${rollbackPath}`);
    console.log(`  ${path.join(outDir, 'manifest.json')}`);
    console.log(`  import.sql sha256：${manifest.sha256OfOrdinary ? '' : manifest.sha256OfImportSql}`);
    console.log('\n=== 下一步 ===');
    console.log(`  1) 备份：cp data/prod.db data/prod.db.bak-$(date +%Y%m%d-%H%M%S)`);
    console.log(`  2) 只读检查：sqlite3 data/prod.db < ${path.join(opts.outDir, 'precheck.sql')}`);
    console.log(`     确认 expected_but_already_exists = 0`);
    console.log(`  3) 导入：sqlite3 data/prod.db < ${path.join(opts.outDir, 'import.sql')}`);
    console.log(`  4) 复核：管理端订单总数、抽查已支付订单的 paymentStatus/paidAt/transactionId`);
    console.log(`\n  [提醒] 输入文件含乘客姓名/手机号/身份证号，生成的 SQL 同样含个人信息，`);
    console.log(`  请勿提交仓库或外发。sql-out/ 已加入 .gitignore。`);
    if (skipped.length) process.exitCode = 2;
}

main();
