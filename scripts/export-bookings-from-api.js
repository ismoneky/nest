#!/usr/bin/env node
/**
 * 事故期订单导出：把仍在进程内存里的订单，经现有 GET 接口拽到本地落成 JSON。
 *
 * ── 为什么必须走 HTTP 而不能直接读 prod.db ─────────────────────────────
 * 2026-09-13 事故：并发事务把 sqlite 单连接的 BEGIN/COMMIT 记账打坏，留下一个
 * 永远不会提交的开放事务。此后进程内的写入全部「成功」但只存在于连接内存里，
 * 磁盘上没有 —— 也就是说**磁盘文件里缺的正是这批数据**，直接读 prod.db 只会
 * 读到旧的、不完整的快照（外部以写方式打开还会报 database is locked）。
 * HTTP 读请求复用同一条连接，因此只有接口能看见这份未提交数据。
 * 详见 src/common/transaction-runner.ts 顶部注释。
 *
 * 结论：**进程重启 = 这份数据永久消失**。本脚本的作用是在重启前把它抢出来。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 * 1) 把 DevTools「Copy as cURL」的内容原样存成文件（bash 或 cmd 格式都认）：
 *      curl 'https://hbfctl.com.cn/api/admin/bookings?page=1&pageSize=10' \
 *        -H 'x-admin-key: <ADMIN_API_KEY>'
 * 2) 运行（默认只拉不写库，安全）：
 *      node scripts/export-bookings-from-api.js --curl=curl.txt
 *
 * 常用参数：
 *   --curl=<file>        curl 命令文件（必填，除非用 --url + --header）
 *   --url=<url>          直接用 URL（配合 --header='k: v'，可重复）
 *   --out-dir=<dir>      输出目录，默认 recovery-export-<时间戳>
 *   --page-size=<n>      每页条数，默认 100（接口 @Max(100)，传大会 400）
 *   --max-pages=<n>      最多拉多少页（防呆）
 *   --keep-raw           保留每页原始响应（默认开；--no-keep-raw 关闭）
 *   --retries=<n>        单页失败重试次数，默认 3
 *   --sleep=<ms>         翻页间隔，默认 120ms（别把线上打挂）
 *   --dry-run            只拉第 1 页验证鉴权和字段，不拉全量
 *
 * 产出（全部在 out-dir 下）：
 *   bookings.json         { meta, bookings: [...] }  —— 交给导入脚本的文件
 *   bookings.jsonl        每行一条，便于流式处理 / 部分损坏时抢救
 *   meta.json             本次导出的元信息、校验和、逐页明细
 *   raw/page-NNNN.json    每页原始响应（取证用，也能在合并出错时重新组装）
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const DEFAULT_PAGE_SIZE = 100; // 接口 pageSize 上限是 100（dto/get-bookings-admin.dto.ts @Max(100)）
const DEFAULT_RETRIES = 3;
const DEFAULT_SLEEP_MS = 120;

// ────────────────────────────── 参数解析 ──────────────────────────────

function parseArgs(argv) {
    const opts = {
        curl: null,
        url: null,
        headers: [],
        outDir: null,
        pageSize: DEFAULT_PAGE_SIZE,
        maxPages: Infinity,
        keepRaw: true,
        retries: DEFAULT_RETRIES,
        sleepMs: DEFAULT_SLEEP_MS,
        dryRun: false,
    };

    for (const arg of argv) {
        const eq = arg.indexOf('=');
        const key = eq === -1 ? arg : arg.slice(0, eq);
        const val = eq === -1 ? null : arg.slice(eq + 1);

        switch (key) {
            case '--curl': opts.curl = requireValue(key, val); break;
            case '--url': opts.url = requireValue(key, val); break;
            case '--header': opts.headers.push(requireValue(key, val)); break;
            case '--out-dir': opts.outDir = requireValue(key, val); break;
            case '--page-size': opts.pageSize = toInt(key, val, { min: 1, max: 100 }); break;
            case '--max-pages': opts.maxPages = toInt(key, val, { min: 1 }); break;
            case '--retries': opts.retries = toInt(key, val, { min: 0 }); break;
            case '--sleep': opts.sleepMs = toInt(key, val, { min: 0 }); break;
            case '--keep-raw': opts.keepRaw = true; break;
            case '--no-keep-raw': opts.keepRaw = false; break;
            case '--dry-run': opts.dryRun = true; break;
            case '--help': case '-h': printHelp(); process.exit(0); break;
            default:
                fail(`未知参数 ${arg}（--help 查看用法）`);
        }
    }
    return opts;
}

function requireValue(key, val) {
    if (val == null || val === '') fail(`${key} 需要取值，例如 ${key}=xxx`);
    return val;
}

function toInt(key, val, { min, max = Infinity }) {
    const n = Number.parseInt(requireValue(key, val), 10);
    if (!Number.isFinite(n) || n < min || n > max) {
        fail(`${key} 取值非法：期望 ${min}~${max === Infinity ? '∞' : max} 的整数，实际「${val}」`);
    }
    return n;
}

function fail(msg) {
    console.error(`\n[导出失败] ${msg}\n`);
    process.exit(1);
}

function printHelp() {
    console.log(`
用法: node scripts/export-bookings-from-api.js --curl=<curl文件> [选项]

  --curl=<file>      curl 命令文件（DevTools「Copy as cURL」原样粘贴）
  --url=<url>        或直接给 URL
  --header='k: v'    配合 --url 使用，可重复
  --out-dir=<dir>    输出目录，默认 recovery-export-<时间戳>
  --page-size=<n>    每页条数，默认 ${DEFAULT_PAGE_SIZE}（上限 100）
  --max-pages=<n>    最多拉多少页
  --no-keep-raw      不保留每页原始响应
  --retries=<n>      单页重试次数，默认 ${DEFAULT_RETRIES}
  --sleep=<ms>       翻页间隔，默认 ${DEFAULT_SLEEP_MS}
  --dry-run          只拉第 1 页验证鉴权与字段
`);
}

// ────────────────────────────── curl 解析 ──────────────────────────────

// DevTools 导出的 HTTP/2 伪首部，curl 会把它们当普通 header 发出去，删掉更干净
const PSEUDO_HEADERS = new Set([':method', ':authority', ':path', ':scheme', ':protocol']);
// 这些开关会改变 curl 的输出形态，导致 stdout 拿不到纯 JSON，直接剔除并告知
const HARMFUL_FLAGS = new Set(['-o', '--output', '-O', '--remote-name', '-i', '--include', '-v', '--verbose', '-D', '--dump-header', '-w', '--write-out', '--trace', '--trace-ascii']);

/**
 * 把一段 curl 命令切成 argv。兼容三种常见粘贴格式：
 *   · bash（POSIX）：单引号包裹 + 行尾反斜杠续行
 *   · cmd.exe      ：双引号包裹 + 行尾 ^ 续行 + 内部 \" 转义
 *   · 单行
 */
function tokenizeCurl(text) {
    // 续行符统一吃掉：bash 的 \<newline> 与 cmd 的 ^<newline>
    const flat = text
        .replace(/\r\n/g, '\n')
        .replace(/\\\n/g, ' ')
        .replace(/\^\n/g, ' ');

    const tokens = [];
    let cur = '';
    let quote = null; // 当前引号类型
    let has = false;  // 当前 token 是否已有内容（区分空串与无 token）

    for (let i = 0; i < flat.length; i++) {
        const ch = flat[i];

        if (quote === "'") {
            if (ch === "'") quote = null;
            else cur += ch;
            continue;
        }
        if (quote === '"') {
            if (ch === '\\' && i + 1 < flat.length) {
                const next = flat[i + 1];
                // cmd 的 \" 与 \\ 才是转义；bash 双引号里的 \" 同理
                if (next === '"' || next === '\\') { cur += next; i++; continue; }
                cur += ch;
                continue;
            }
            if (ch === '"') quote = null;
            else cur += ch;
            continue;
        }

        if (ch === "'" || ch === '"') { quote = ch; has = true; continue; }
        if (/\s/.test(ch)) {
            if (has) { tokens.push(cur); cur = ''; has = false; }
            continue;
        }
        if (ch === '\\' && i + 1 < flat.length) { cur += flat[i + 1]; i++; has = true; continue; }
        cur += ch;
        has = true;
    }
    if (has) tokens.push(cur);
    return tokens;
}

/**
 * 从 curl argv 里定位 URL 所在下标。
 * 支持裸 URL 与 --url <u> / --url=<u> 两种写法；只认 http(s)。
 */
function locateUrl(tokens) {
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t === '--url') {
            if (i + 1 >= tokens.length) fail('curl 里的 --url 后面没有取值');
            return { index: i + 1 };
        }
        if (t.startsWith('--url=')) {
            // 就地替换整个 token
            tokens[i] = t.slice('--url='.length);
            return { index: i };
        }
        if (/^https?:\/\//i.test(t)) return { index: i };
    }
    return null;
}

/**
 * 解析 curl 文本 → { argv, urlIndex, notes }。
 * argv 里凡是会污染 stdout 的开关都被剔除，并在 notes 里说明。
 */
function buildCurlPlan(curlText) {
    let tokens = tokenizeCurl(curlText);
    if (tokens.length === 0) fail('curl 文件是空的');

    // 去掉开头的 curl / curl.exe
    if (/^curl(\.exe)?$/i.test(tokens[0])) tokens = tokens.slice(1);

    const notes = [];
    const argv = [];
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        const flag = t.includes('=') ? t.slice(0, t.indexOf('=')) : t;

        if (HARMFUL_FLAGS.has(flag)) {
            notes.push(`已剔除开关 ${flag}（它会改变 curl 输出，导致拿不到纯 JSON）`);
            // 形如 -o file 的，把它的取值也跳过
            if (!t.includes('=') && i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) i++;
            continue;
        }
        argv.push(t);
    }

    const found = locateUrl(argv);
    if (!found) fail('在 curl 命令里找不到 http(s) URL');

    // 剔除 HTTP/2 伪首部 header
    const cleaned = [];
    for (let i = 0; i < argv.length; i++) {
        if (/^-H$|^--header$/.test(argv[i]) && i + 1 < argv.length) {
            const h = argv[i + 1];
            const name = h.slice(0, h.indexOf(':')).trim().toLowerCase();
            if (PSEUDO_HEADERS.has(name)) { notes.push(`已剔除伪首部 header ${name}`); i++; continue; }
        }
        cleaned.push(argv[i]);
    }

    // 位置会因上面的剔除而变，重新定位
    const finalFound = locateUrl(cleaned);
    if (!finalFound) fail('剔除无用 header 后找不到 URL（内部错误）');

    if (!cleaned.includes('-s') && !cleaned.includes('--silent') && !cleaned.some((t) => t.startsWith('--silent'))) {
        // 不静默的话 curl 会往 stderr 打进度条，不影响 stdout，但会刷屏
        cleaned.unshift('-s');
        finalFound.index += 1;
    }

    return { argv: cleaned, urlIndex: finalFound.index, notes };
}

function buildPlanFromUrl(url, headers) {
    const argv = ['-s'];
    for (const h of headers) argv.push('-H', h);
    argv.push(url);
    return { argv, urlIndex: argv.length - 1, notes: [] };
}

// ────────────────────────────── 翻页执行 ──────────────────────────────

function withPage(url, page, pageSize) {
    let u;
    try {
        u = new URL(url);
    } catch {
        fail(`URL 无法解析：${url}`);
    }
    u.searchParams.set('page', String(page));
    u.searchParams.set('pageSize', String(pageSize));
    return u.toString();
}

function curlish(argv) {
    // 打印时把可能带密钥的 header 打码，避免密钥进终端日志/录屏
    const masked = argv.map((t) => {
        if (/^(x-admin-key|authorization|cookie)$/i.test(t.slice(0, t.indexOf(':')).trim())) {
            const name = t.slice(0, t.indexOf(':'));
            return `${name}: ***`;
        }
        return t;
    });
    return `curl ${masked.map((t) => (/\s/.test(t) ? JSON.stringify(t) : t)).join(' ')}`;
}

function runCurl(argv) {
    try {
        const out = execFileSync('curl', argv, {
            encoding: 'buffer',
            maxBuffer: 256 * 1024 * 1024, // 单页 100 条其实很小，给足余量
            windowsHide: true,
        });
        return { ok: true, body: out };
    } catch (err) {
        return {
            ok: false,
            error: err && err.message ? err.message : String(err),
            stderr: err && err.stderr ? err.stderr.toString('utf8').slice(0, 2000) : '',
        };
    }
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * 拉一页，带重试。返回 { payload, rawText }。
 * 明确区分「网络/curl 失败」与「接口返回了业务错误」，后者不重试。
 */
async function fetchPage(plan, url, retries) {
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) {
            const backoff = 500 * attempt;
            console.error(`    重试 ${attempt}/${retries}（${backoff}ms 后）...`);
            await sleep(backoff);
        }
        const argv = [...plan.argv];
        argv[plan.urlIndex] = url;
        const res = runCurl(argv);

        if (!res.ok) {
            lastErr = `curl 执行失败: ${res.error}${res.stderr ? ` | stderr: ${res.stderr}` : ''}`;
            continue;
        }

        const rawText = res.body.toString('utf8');
        let payload;
        try {
            payload = JSON.parse(rawText);
        } catch {
            // 拿到的不是 JSON：最常见是反代返回了 HTML 错误页，或鉴权被挡
            lastErr = `响应不是 JSON（前 300 字符）：${rawText.slice(0, 300).replace(/\s+/g, ' ')}`;
            continue;
        }

        if (payload && payload.success === false) {
            fail(
                `接口返回业务失败：${payload.message || JSON.stringify(payload).slice(0, 300)}\n` +
                `  这通常说明鉴权头不对（管理员接口需要 x-admin-key）或参数被校验拒绝。\n` +
                `  本次请求：${curlish(argv)}`,
            );
        }
        if (!payload || !Array.isArray(payload.data)) {
            fail(`接口响应结构不符合预期（data 不是数组）：${JSON.stringify(payload).slice(0, 300)}`);
        }
        return { payload, rawText };
    }
    fail(`翻页请求连续失败：${lastErr}`);
}

// ────────────────────────────── 主流程 ──────────────────────────────

async function main() {
    const opts = parseArgs(process.argv.slice(2));

    if (!opts.curl && !opts.url) fail('必须提供 --curl=<文件> 或 --url=<URL>');

    let plan;
    if (opts.curl) {
        if (!fs.existsSync(opts.curl)) fail(`curl 文件不存在：${opts.curl}`);
        plan = buildCurlPlan(fs.readFileSync(opts.curl, 'utf8'));
    } else {
        plan = buildPlanFromUrl(opts.url, opts.headers);
    }

    const outDir = path.resolve(opts.outDir || `recovery-export-${timestamp()}`);
    const rawDir = path.join(outDir, 'raw');
    fs.mkdirSync(rawDir, { recursive: true });

    const baseUrl = plan.argv[plan.urlIndex];

    console.log('=== 订单导出（事故抢救） ===');
    for (const n of plan.notes) console.log(`  注意：${n}`);
    console.log(`  目标：${maskUrl(baseUrl)}`);
    console.log(`  参数：pageSize=${opts.pageSize} maxPages=${opts.maxPages === Infinity ? '∞' : opts.maxPages}`);
    console.log(`  输出：${outDir}`);
    console.log('');

    // ── 第 1 页：先确认鉴权与 total，再决定要不要继续 ──
    const first = await fetchPage(plan, withPage(baseUrl, 1, opts.pageSize), opts.retries);
    const firstTotal = readTotal(first.payload);
    if (opts.keepRaw) fs.writeFileSync(path.join(rawDir, 'page-0001.json'), first.rawText);

    console.log(`  鉴权 OK，total = ${firstTotal == null ? '未知（响应里没有 pagination）' : firstTotal}，首页返回 ${first.payload.data.length} 条`);
    if (first.payload.data.length > 0) {
        const sample = first.payload.data[0];
        console.log(`  字段样例（${Object.keys(sample).length} 个）：${Object.keys(sample).join(', ')}`);
    }

    if (opts.dryRun) {
        console.log('\n  --dry-run：只验证了第 1 页，未拉全量。去掉该参数即可正式导出。');
        return;
    }

    // 拿不到 total 时绝不能只拉一页就收工 —— 那会静默截断。
    // 退化为「一直翻到某页不满 pageSize 为止」，并在结尾要求人工核对条数。
    const unknownTotal = firstTotal == null;
    if (unknownTotal) {
        console.error('  [警告] 响应里没有 pagination.total，无法预知总页数。');
        console.error('  改为「翻到某页不满一页为止」；结束后请务必人工核对条数是否完整。\n');
    }
    const totalPages = unknownTotal ? Infinity : Math.max(1, Math.ceil(firstTotal / opts.pageSize));
    if (!unknownTotal) console.log(`  预计需要 ${totalPages} 页（每页 ${opts.pageSize} 条）\n`);

    // ── 逐页拉取 ──
    const byKey = new Map();   // bookingId → 行；同时用它去重
    const pageStats = [];
    let totalDrift = null;
    let stopReason = null;

    const pages = [1];

    for (let idx = 0; idx < pages.length; idx++) {
        const page = pages[idx];
        let payload, rawText;

        if (page === 1) {
            payload = first.payload;
            rawText = first.rawText;
        } else {
            await sleep(opts.sleepMs);
            const res = await fetchPage(plan, withPage(baseUrl, page, opts.pageSize), opts.retries);
            payload = res.payload;
            rawText = res.rawText;
            if (opts.keepRaw) fs.writeFileSync(path.join(rawDir, `page-${String(page).padStart(4, '0')}.json`), rawText);
        }

        // 事故期间数据还在动：每页都核对 total，变了要留痕（不中断导出）
        const t = readTotal(payload);
        if (t != null && t !== firstTotal && totalDrift == null) {
            totalDrift = { firstSeen: firstTotal, changedTo: t, atPage: page };
        }

        let added = 0;
        for (const row of payload.data) {
            const key = rowKey(row);
            if (byKey.has(key)) continue; // 分页漂移导致的重复，丢掉后来者
            byKey.set(key, row);
            added++;
        }
        pageStats.push({ page, returned: payload.data.length, added, total: t });

        const pct = unknownTotal ? '' : `（${((idx + 1) / totalPages * 100).toFixed(1)}%）`;
        process.stdout.write(`\r  拉取中 第 ${idx + 1} 页${pct} 已收集 ${byKey.size} 条   `);

        // ── 是否继续翻页 ──
        if (idx + 1 >= opts.maxPages) {
            stopReason = `达到 --max-pages=${opts.maxPages} 上限`;
            break;
        }

        if (unknownTotal) {
            if (payload.data.length < opts.pageSize) {
                stopReason = `第 ${page} 页只返回 ${payload.data.length} 条（不满一页），判定为末页`;
                break;
            }
            pages.push(page + 1);
            continue;
        }

        if (firstTotal === 0) {
            stopReason = '接口报告 total=0，库里没有订单';
            break;
        }
        if (payload.data.length === 0) {
            stopReason = `第 ${page} 页返回 0 条但预期共 ${totalPages} 页`;
            break;
        }

        // 补齐：若导出期间 total 变大，动态追加页
        const need = t != null ? Math.ceil(t / opts.pageSize) : totalPages;
        for (let p = pages.length + 1; p <= need; p++) pages.push(p);
        if (idx + 1 >= pages.length) {
            stopReason = `已翻完全部 ${pages.length} 页`;
            break;
        }
    }
    process.stdout.write('\n\n');
    if (stopReason) console.log(`  结束翻页：${stopReason}`);

    // ── 组装产物 ──
    const bookings = [...byKey.values()];
    const meta = {
        exportedAt: new Date().toISOString(),
        source: maskUrl(baseUrl),
        pageSize: opts.pageSize,
        pagesFetched: pageStats.length,
        totalReported: firstTotal,
        rowsExported: bookings.length,
        totalDrift,
        pageStats,
        sha256OfBookings: sha256(JSON.stringify(bookings)),
        note: '事故期从进程内存经 HTTP 抢出的数据。进程重启后这份 JSON 即唯一副本。',
    };

    fs.writeFileSync(path.join(outDir, 'bookings.json'), JSON.stringify({ meta, bookings }, null, 2), 'utf8');
    fs.writeFileSync(
        path.join(outDir, 'bookings.jsonl'),
        bookings.map((b) => JSON.stringify(b)).join('\n') + (bookings.length ? '\n' : ''),
        'utf8',
    );
    fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');

    // ── 汇总与自检 ──
    console.log('=== 导出完成 ===');
    console.log(`  条数：${bookings.length}（接口报告 total=${firstTotal == null ? '未知' : firstTotal}）`);
    console.log(`  sha256：${meta.sha256OfBookings}`);
    console.log(`  文件：${path.join(outDir, 'bookings.json')}`);
    console.log(`        ${path.join(outDir, 'bookings.jsonl')}`);

    let alerted = false;
    if (unknownTotal) {
        alerted = true;
        console.error(
            `\n  [注意] 接口没给 total，无法自动核对完整性。请用管理端列表的总数人工比对本次的 ${bookings.length} 条。`,
        );
    } else if (bookings.length < firstTotal) {
        alerted = true;
        console.error(
            `\n  [严重] 实际拿到 ${bookings.length} 条，少于接口报告的 ${firstTotal} 条，差 ${firstTotal - bookings.length} 条！\n` +
            `  请在进程重启前重跑本脚本（raw/ 下已存档每页响应，可人工比对定位缺哪几页）。`,
        );
    }
    if (totalDrift) {
        alerted = true;
        console.error(
            `\n  [警告] 导出期间 total 发生变化：${totalDrift.firstSeen} → ${totalDrift.changedTo}（第 ${totalDrift.atPage} 页起）。\n` +
            `  说明线上仍在写入，本次导出不是一致快照。raw/ 已留存各页原文。`,
        );
    }
    console.log(
        `\n  [提醒] 导出文件含乘客姓名/手机号/身份证号，属个人信息。\n` +
        `  已把 recovery-export-* 加入 .gitignore；请勿把这些文件发到聊天工具或提交仓库。`,
    );

    console.log(`\n  下一步：node scripts/import-bookings-to-db.js --in=${path.join(outDir, 'bookings.json')} --db=data/prod.db`);
    console.log('  （导入脚本默认 dry-run，确认统计无误后再加 --apply 真正写库）');
    if (alerted) process.exitCode = 2;
}

function readTotal(payload) {
    const t = payload && payload.pagination ? payload.pagination.total : null;
    return typeof t === 'number' ? t : null;
}

/** 优先用 bookingId（唯一），退化为 id；都没有则用整行哈希兜底 */
function rowKey(row) {
    if (row && row.bookingId) return `bid:${row.bookingId}`;
    if (row && row.id != null) return `id:${row.id}`;
    return `sha:${sha256(JSON.stringify(row || {}))}`;
}

function sha256(s) {
    return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function timestamp() {
    const d = new Date();
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function maskUrl(url) {
    try {
        const u = new URL(url);
        for (const k of [...u.searchParams.keys()]) {
            if (/key|token|secret|sign/i.test(k)) u.searchParams.set(k, '***');
        }
        return u.toString();
    } catch {
        return url;
    }
}

main().catch((err) => {
    console.error(`\n[导出异常] ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
});
