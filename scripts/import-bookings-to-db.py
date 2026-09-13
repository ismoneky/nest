#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
事故恢复：把导出的订单 JSON 写回线上 SQLite 数据文件（Python 版，只用标准库）。

与 scripts/import-bookings-to-db.js **行为一致**，给没装 node 的机器用。
线上是 docker 部署：代码烤在镜像里，只有 data/ 是挂载出来的，
所以本脚本直接在**宿主机**上对着 data/prod.db 跑就行，不需要进容器。

── 设计上的几条硬原则（与 JS 版逐条对齐）────────────────────────────────
1. **默认 dry-run**。不加 --apply 绝不写库，只打印将要发生的增删改统计。
2. **以 bookingId 为准，不看自增 id**。id 是本地产物，跨快照不可信。
3. **绝不覆盖更新的数据**。已存在的行只有 updatedAt 比导入值更旧时才更新，
   判断条件写进 UPDATE ... WHERE，避免预演与写入之间的竞态。
4. **单事务**。默认整批一个 BEGIN IMMEDIATE ... COMMIT，失败全量回滚。
5. **动库前先备份**，且备份分两份（逻辑一致 + 原始字节）。

── 与 JS 版的两处实现差异（都是为了不依赖新版 sqlite）─────────────────
· 插入不用 ON CONFLICT(bookingId) DO NOTHING（需要 SQLite ≥ 3.24），
  改成事务内先 SELECT 再 INSERT —— 我们持有 BEGIN IMMEDIATE 写锁，
  中间没有别的写者能插进来，语义等价。
· 逻辑备份不用 VACUUM INTO（需要 SQLite ≥ 3.27），改用 Python 的
  Connection.backup()：它是**阻塞式**的整库复制，返回即完成。
  （node-sqlite3 的 db.backup() 是增量式的，回调只表示"已启动"，
  把它当完成用会产出 0 字节文件 —— 这正是 JS 版踩过的坑。）

── 用法 ────────────────────────────────────────────────────────────────
  # 1) 先空跑，核对统计（不写库）
  python3 scripts/import-bookings-to-db.py --in=recovery-export-xxx/bookings.json --db=data/prod.db

  # 2) 确认无误后真正写库（自动备份）
  python3 scripts/import-bookings-to-db.py --in=... --db=data/prod.db --apply

选项：
  --in=<file>        导出的 bookings.json（必填）
  --db=<file>        SQLite 库路径，默认取环境变量 DATABASE_PATH，否则 data/prod.db
  --apply            真正写库（默认只读空跑）
  --backup           写库前备份（--apply 时默认开启；--no-backup 关闭）
  --batch=<n>        每 n 行提交一次（默认 0 = 整批一个事务）
  --table=<name>     目标表名，默认 bookings
  --report=<file>    报告输出路径，默认 import-report-<时间戳>.json
  --allow-shape-drift       JSON 字段与表结构对不上时继续（默认中止）
  --allow-hash-mismatch     sha256 对不上时仍允许 --apply（默认拒绝）
  --skip-integrity          跳过 preflight 的 quick_check
"""

import hashlib
import io
import json
import os
import re
import shutil
import sqlite3
import sys
from datetime import datetime, timedelta, timezone

# 线上常是 POSIX locale，直接 print 中文会 UnicodeEncodeError，先兜住
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')  # Python 3.7+
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except AttributeError:
    try:  # Python 3.6
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')
    except Exception:
        pass
except Exception:
    pass

if sys.version_info < (3, 6):
    sys.stderr.write(
        "\n[导入中止] 需要 Python 3.6 或更高版本（当前 %s）。\n\n"
        "  没装 python3 也不用装 —— 直接用容器跑这个脚本：\n"
        "    docker run --rm -v /app/backend:/w -w /w python:3.11 \\\n"
        "      python scripts/import-bookings-to-db.py --in=recovery-export-xxx/bookings.json --db=data/prod.db\n\n"
        % (sys.version.split()[0],)
    )
    sys.exit(1)

REPORT_CAP = 200


# ────────────────────────────── 小工具 ──────────────────────────────

def die(msg):
    sys.stderr.write("\n[导入中止] %s\n\n" % msg)
    sys.exit(1)


def p2(n):
    return "%02d" % n


def ts_name():
    """与 JS 的 new Date().toISOString().replace(/[:.]/g,'-') 同形"""
    return datetime.utcnow().strftime('%Y-%m-%dT%H-%M-%S-%f')[:-3] + 'Z'


def brief(obj, n=160):
    try:
        s = json.dumps(obj, ensure_ascii=False, separators=(',', ':'))
    except Exception:
        s = str(obj)
    return s[:n]


def quote_ident(name):
    return '"%s"' % str(name).replace('"', '""')


# ────────────────────────────── 类型归一化 ──────────────────────────────

_ISO_RE = re.compile(
    r'^(\d{4})-(\d{2})-(\d{2})'
    r'(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?'
    r'(Z|z|[+-]\d{2}:?\d{2})?$')


def _parse_iso_manual(s):
    """
    Python 3.6 没有 datetime.fromisoformat，手动解析 ISO 8601 的常见写法。
    （3.6 的 strptime %z 又不认 '+00:00' 这种带冒号的形式，所以只能自己来。）
    """
    m = _ISO_RE.match(s)
    if not m:
        return None
    y, mo, d, hh, mi, ss, frac, off = m.groups()
    try:
        tz = None
        if off:
            if off in ('Z', 'z'):
                tz = timezone.utc
            else:
                body = off.replace(':', '')
                sign = -1 if body[0] == '-' else 1
                tz = timezone(sign * timedelta(hours=int(body[1:3]), minutes=int(body[3:5])))
        return datetime(int(y), int(mo), int(d), int(hh or 0), int(mi or 0), int(ss or 0),
                        int((frac or '0').ljust(6, '0')), tz)
    except ValueError:
        return None


def parse_dt(value):
    """模拟 JS 的 new Date(x)。返回 datetime；带时区的保持原时区（调用方决定要不要转本地）。"""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(value / 1000.0)  # JS 的数字入参按毫秒
        except (ValueError, OSError, OverflowError):
            return None
    if not isinstance(value, str):
        return None
    s = value.strip()
    if s[-1:] in ('Z', 'z'):
        s = s[:-1] + '+00:00'
    try:
        return datetime.fromisoformat(s)
    except AttributeError:
        pass  # Python 3.6 没有这个方法，走下面的手动解析
    except ValueError:
        pass
    manual = _parse_iso_manual(s)
    if manual is not None:
        return manual
    for fmt in ('%Y-%m-%dT%H:%M:%S.%f%z', '%Y-%m-%dT%H:%M:%S%z',
                '%Y-%m-%d %H:%M:%S.%f', '%Y-%m-%d %H:%M:%S', '%Y/%m/%d'):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def normalize_value(value, coltype, col):
    """
    把接口返回的 JSON 值还原成 SQLite 里该列真正的存储形态。

    「直接把 JSON 塞回去」是这类恢复脚本最容易翻车的地方：实体上挂了
    timestamp.transformer，库里存毫秒整数而 JSON 里是 ISO 字符串；
    bookingDate 是 date 列存 'YYYY-MM-DD'；isFree 是 boolean 存 0/1。
    不做这层转换就会出现「导入成功但全是脏数据」，比导入失败更糟。
    """
    t = (coltype or '').lower()

    if value is None:
        return None

    # boolean 列：JSON 给 true/false，sqlite 存 1/0
    if 'bool' in t:
        if isinstance(value, bool):
            return 1 if value else 0
        if isinstance(value, (int, float)):
            return 1 if value else 0
        if value in ('true', '1'):
            return 1
        if value in ('false', '0'):
            return 0
        return 1 if value else 0

    # date 列：只保留日期部分。已是 'YYYY-MM-DD' 就原样保留（不重新 parse，
    # 避免把纯日期拖进时区换算）；是 ISO 时间就取**本地**分量格式化，
    # 与 TypeORM 写该列时 DateUtils.mixedDateToDateString 的语义一致。
    if t in ('date', 'datetime') or re.search(r'date$', col or '', re.I):
        if isinstance(value, str) and re.match(r'^\d{4}-\d{2}-\d{2}$', value):
            return value
        d = parse_dt(value)
        if d is None:
            return str(value)
        if d.tzinfo is not None:
            d = d.astimezone()  # JS 的 getFullYear()/getMonth() 取的是本地分量
        return "%04d-%02d-%02d" % (d.year, d.month, d.day)

    # 整数/数字列：ISO 字符串转毫秒时间戳，数字原样，纯数字串转数字
    if ('int' in t) or ('real' in t) or ('numeric' in t) or ('decimal' in t):
        if isinstance(value, bool):
            return 1 if value else 0
        if isinstance(value, (int, float)):
            return value
        if isinstance(value, str):
            if re.match(r'^-?\d+$', value):
                return int(value)
            d = parse_dt(value)
            if d is not None:
                # round 不能省：timestamp() 是浮点，直接 int() 截断会差 1 毫秒
                return int(round(d.timestamp() * 1000))
            return value
        return value

    # 其余按文本处理；对象/数组先序列化（passengers 在实体里就是 JSON 字符串）
    if isinstance(value, (dict, list)):
        return json.dumps(value, separators=(',', ':'), ensure_ascii=False)
    return value


def version_of(row):
    """取「版本号」，用于判断哪边更新。缺失时返回 None，调用方按「无法比较」处理。"""
    v = row.get('updatedAt') if isinstance(row, dict) else None
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return int(v)
    if isinstance(v, str) and re.match(r'^-?\d+$', v):
        return int(v)
    d = parse_dt(v)
    if d is None:
        return None
    return int(round(d.timestamp() * 1000))


def digest_candidates(bookings):
    """
    复刻 JS 的 sha256(JSON.stringify(bookings))：紧凑分隔符、不转义非 ASCII。
    同时算一份 ensure_ascii=True 的备选 —— 万一两边序列化有差异，
    也不至于让「文件其实是好的」被判成损坏。
    """
    out = {}
    for ascii_flag in (False, True):
        try:
            s = json.dumps(bookings, separators=(',', ':'), ensure_ascii=ascii_flag)
        except (TypeError, ValueError):
            continue
        out[hashlib.sha256(s.encode('utf-8')).hexdigest()] = ascii_flag
    return out


# ────────────────────────────── SQL 构造 ──────────────────────────────

def usable_columns(row, by_name):
    """只取 JSON 里有、且表里也有的列"""
    return [k for k in row.keys() if k in by_name]


def build_insert(table, row, by_name, omit_id):
    cols = [c for c in usable_columns(row, by_name) if not (omit_id and c == 'id')]
    params = [normalize_value(row[c], by_name[c]['type'], c) for c in cols]
    sql = "INSERT INTO %s (%s) VALUES (%s)" % (
        quote_ident(table),
        ', '.join(quote_ident(c) for c in cols),
        ', '.join('?' for _ in cols),
    )
    return sql, params


def build_update(table, row, by_name):
    """
    更新：只写 JSON 里出现过的列，并把版本判断放进 WHERE，让「线上是否已有更新版本」
    在事务里重新裁决一次。显式排除 id —— id 是本地自增产物，绝不能跟着数据一起搬。
    """
    cols = [c for c in usable_columns(row, by_name) if c != 'id']
    params = [normalize_value(row[c], by_name[c]['type'], c) for c in cols]
    params.append(row.get('bookingId'))
    params.append(version_of(row))
    sql = "UPDATE %s SET %s WHERE bookingId = ? AND (updatedAt IS NULL OR updatedAt <= ?)" % (
        quote_ident(table),
        ', '.join('%s = ?' % quote_ident(c) for c in cols),
    )
    return sql, params


def fix_sequence(conn, table):
    """校正 AUTOINCREMENT 序列，避免后续新订单重用已占用的 id"""
    try:
        has_seq = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'").fetchone()
        if not has_seq:
            return '无 sqlite_sequence（表未用 AUTOINCREMENT），跳过'
        row = conn.execute("SELECT MAX(id) AS m FROM %s" % quote_ident(table)).fetchone()
        max_id = (row[0] or 0) if row else 0
        cur = conn.execute("SELECT seq FROM sqlite_sequence WHERE name = ?", (table,)).fetchone()
        if not cur:
            if max_id > 0:
                conn.execute("INSERT INTO sqlite_sequence(name, seq) VALUES (?, ?)", (table, max_id))
            return '已初始化 seq=%d' % max_id
        cur_seq = cur[0] or 0
        if int(cur_seq) < int(max_id):
            conn.execute("UPDATE sqlite_sequence SET seq = ? WHERE name = ?", (max_id, table))
            return '已从 %s 提升到 %s' % (cur_seq, max_id)
        return '无需调整（seq=%s ≥ max(id)=%s）' % (cur_seq, max_id)
    except sqlite3.Error as err:
        return '校正失败（不致命，但请留意）：%s' % err


# ────────────────────────────── 预检 ──────────────────────────────

def preflight(db_file, table, skip_integrity):
    print('=== 环境预检 ===')

    # 归档文件的存在本身就是证据：非空 journal 说明有未提交事务
    for suffix in ('-journal', '-wal', '-shm'):
        f = db_file + suffix
        if os.path.exists(f):
            size = os.path.getsize(f)
            print('  发现 %s（%s 字节）' % (os.path.basename(f), size))
            if suffix == '-journal' and size > 0:
                print('    ↑ 非空 journal：磁盘上很可能还有一个未提交事务，导入前务必先备份它。')

    try:
        conn = sqlite3.connect(db_file, timeout=5, isolation_level=None)
        try:
            conn.execute('PRAGMA busy_timeout = 5000')
            jm = conn.execute('PRAGMA journal_mode').fetchone()
            print('  journal_mode = %s' % (jm[0] if jm else '?'))
            t = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()
            print('  表 %s：%s' % (table, '存在' if t else '不存在 ← 要小心'))
            if not skip_integrity:
                chk = conn.execute('PRAGMA quick_check').fetchone()
                v = chk[0] if chk else '?'
                print('  quick_check = %s' % v)
                if str(v).lower() != 'ok':
                    print('    ↑ 库文件已有损坏，导入前请保留一份原始副本'
                          '（本脚本的备份是逻辑备份，可能无法复制损坏页）。')
        finally:
            conn.close()
    except sqlite3.Error as err:
        print('  只读预检失败：%s（继续尝试主流程）' % err)
    print('')


# ────────────────────────────── 备份 ──────────────────────────────

def logical_backup(conn, db_file, dest, table):
    """
    产出一份完整、可独立打开的库，导入失败时用它回滚。

    Python 3.7+ 走 Connection.backup()：**阻塞式**整库复制，返回即完成。
    不要用 node-sqlite3 那种「只启动不等待」的增量回调 —— 那会产出 0 字节文件，
    等于把「可回滚」变成「覆盖成空库」（JS 版踩过这个坑）。

    Python 3.6 没有这个 API，退化成整文件复制：它是字节副本，一致性依赖
    「此刻没有别的写者」（服务刚重启完、预约入口已关停，所以成立）。
    无论走哪条路，下面都照样做完整校验，校验不过就中止。
    """
    if os.path.exists(dest):
        os.remove(dest)

    if hasattr(conn, 'backup'):
        target = sqlite3.connect(dest, isolation_level=None)
        try:
            conn.backup(target)
        finally:
            target.close()
        how = '逻辑备份'
    else:
        shutil.copy2(db_file, dest)
        how = '字节副本（Python %d.%d 没有 sqlite3 备份 API）' % sys.version_info[:2]

    size = os.path.getsize(dest) if os.path.exists(dest) else 0
    if size == 0:
        raise RuntimeError('逻辑备份产出 0 字节：%s' % dest)

    # 独立打开副本核对「能打开 + 完整 + 行数一致」——备份不能只看文件是否存在
    copy = sqlite3.connect(dest, timeout=5, isolation_level=None)
    try:
        copy.execute('PRAGMA busy_timeout = 5000')
        chk = copy.execute('PRAGMA quick_check').fetchone()
        verdict = chk[0] if chk else '?'
        if str(verdict).lower() != 'ok':
            raise RuntimeError('逻辑备份 quick_check = %s' % verdict)
        src_rows = conn.execute('SELECT COUNT(*) FROM %s' % quote_ident(table)).fetchone()[0]
        copy_rows = copy.execute('SELECT COUNT(*) FROM %s' % quote_ident(table)).fetchone()[0]
        if src_rows != copy_rows:
            raise RuntimeError('逻辑备份行数不一致：源 %s / 副本 %s' % (src_rows, copy_rows))
        return size, copy_rows, how
    finally:
        copy.close()


def do_backup(conn, db_file, table):
    """
    备份分两份，用途不同，缺一不可：
      · 逻辑一致的库 → 导入失败时用它回滚（只含已提交数据）
      · 原始字节副本 + journal/wal → 取证用
    """
    ts = ts_name()
    logical = '%s.pre-import-%s' % (db_file, ts)
    raw_copy = '%s.rawcopy-%s' % (db_file, ts)

    print('=== 备份 ===')
    size, rows, how = logical_backup(conn, db_file, logical, table)
    print('  逻辑备份：%s（%s 字节 / %s 行，%s，已独立打开校验 quick_check=ok）'
          % (logical, size, rows, how))

    shutil.copy2(db_file, raw_copy)
    print('  原始副本：%s（%s 字节）' % (raw_copy, os.path.getsize(raw_copy)))

    for suffix in ('-journal', '-wal', '-shm'):
        f = db_file + suffix
        if not os.path.exists(f):
            continue
        dest = raw_copy + suffix
        shutil.copy2(f, dest)
        with open(f, 'rb') as fh:
            sha = hashlib.sha256(fh.read()).hexdigest()
        print('  归档副本：%s（sha256 %s…）' % (dest, sha[:16]))
    print('  回滚方式：停服务后把 %s 覆盖回 %s' % (os.path.basename(logical), os.path.basename(db_file)))
    print('')


# ────────────────────────────── 报告 ──────────────────────────────

def write_report(opts, data):
    plan = data['plan']
    report = {
        'generatedAt': datetime.utcnow().isoformat() + 'Z',
        'applied': data['applied'],
        'input': data['in_file'],
        'database': data['db_file'],
        'table': opts.table,
        'counts': dict({
            'insert': len(plan['insert']),
            'update': len(plan['update']),
            'stale': len(plan['stale']),
            'conflict': len(plan['conflict']),
            'bad': len(plan['bad']),
        }, **({
            'insertedOk': data['stats']['inserted'],
            'updatedOk': data['stats']['updated'],
            'skippedConcurrent': data['stats']['skippedConcurrent'],
            'failed': len(data['stats']['errors']),
        } if data.get('stats') else {})),
        'after': data.get('after'),
        # 明细截断保存，避免几万条全量刷进报告
        'details': {
            'insertBookingIds': [r.get('bookingId') for r in plan['insert'][:REPORT_CAP]],
            'updatedBookingIds': [i['row'].get('bookingId') for i in plan['update'][:REPORT_CAP]],
            'stale': plan['stale'][:REPORT_CAP],
            'conflict': plan['conflict'][:REPORT_CAP],
            'bad': [{'reason': b['reason'], 'bookingId': (b['row'] or {}).get('bookingId')}
                    for b in plan['bad'][:REPORT_CAP]],
            'errors': data['stats']['errors'][:REPORT_CAP] if data.get('stats') else [],
        },
        'truncatedAt': REPORT_CAP,
    }
    file = os.path.abspath(opts.report or ('import-report-%s.json' % ts_name()))
    with open(file, 'w', encoding='utf-8') as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2)
    return file


# ────────────────────────────── 参数 ──────────────────────────────

class Opts(object):
    pass


def parse_args(argv):
    opts = Opts()
    opts.in_file = None
    opts.db_file = os.environ.get('DATABASE_PATH') or os.path.join('data', 'prod.db')
    opts.apply = False
    opts.backup = None
    opts.batch = 0
    opts.table = 'bookings'
    opts.report = None
    opts.allow_shape_drift = False
    opts.allow_hash_mismatch = False
    opts.skip_integrity = False

    flags = {
        '--apply': ('apply', True),
        '--backup': ('backup', True),
        '--no-backup': ('backup', False),
        '--allow-shape-drift': ('allow_shape_drift', True),
        '--allow-hash-mismatch': ('allow_hash_mismatch', True),
        '--skip-integrity': ('skip_integrity', True),
    }
    vals = {'--in': 'in_file', '--db': 'db_file', '--table': 'table', '--report': 'report', '--batch': 'batch'}

    for arg in argv:
        eq = arg.find('=')
        key = arg if eq == -1 else arg[:eq]
        val = None if eq == -1 else arg[eq + 1:]
        if key in ('--help', '-h'):
            print(__doc__)
            sys.exit(0)
        if key in flags:
            if val is not None:
                die('%s 不接受取值' % key)
            setattr(opts, flags[key][0], flags[key][1])
            continue
        if key in vals:
            if val is None or val == '':
                die('%s 需要取值' % key)
            if key == '--batch':
                if not re.match(r'^\d+$', val):
                    die('--batch 取值非法，期望 ≥0 的整数')
                val = int(val)
            setattr(opts, vals[key], val)
            continue
        die('未知参数 %s（--help 查看用法）' % arg)

    if opts.backup is None:
        opts.backup = opts.apply
    return opts


# ────────────────────────────── 主流程 ──────────────────────────────

def main():
    opts = parse_args(sys.argv[1:])
    if not opts.in_file:
        die('必须提供 --in=<bookings.json>')

    in_file = os.path.abspath(opts.in_file)
    db_file = os.path.abspath(opts.db_file)
    if not os.path.exists(in_file):
        die('导入文件不存在：%s' % in_file)
    if not os.path.exists(db_file):
        die('数据库文件不存在：%s\n  线上应在后端目录下，例如 /app/backend/data/prod.db' % db_file)

    # ── 读输入 ──
    try:
        with open(in_file, 'r', encoding='utf-8') as fh:
            raw = json.load(fh)
    except ValueError as err:
        die('导入文件不是合法 JSON：%s' % err)

    bookings = raw if isinstance(raw, list) else raw.get('bookings')
    if not isinstance(bookings, list) or not bookings:
        die('导入文件里没有 bookings 数组，或数组为空')

    print('=== 订单导入 ===')
    print('  来源：%s' % in_file)
    print('  目标：%s' % db_file)
    print('  条数：%d' % len(bookings))
    meta = raw.get('meta') if isinstance(raw, dict) else None
    if meta:
        print('  导出时间：%s' % meta.get('exportedAt'))
        stored = meta.get('sha256OfBookings')
        if stored:
            cands = digest_candidates(bookings)
            if stored in cands:
                print('  校验：sha256 与导出时一致 ✓')
            else:
                print('  [警告] 校验失败！导出时 sha256=%s' % stored)
                print('         当前算得：%s' % '、'.join(cands.keys()))
                print('  文件被改过、传输中损坏，或只是 Python 与 Node 的 JSON 序列化差异。')
                print('  确认文件没被动过，可以加 --allow-hash-mismatch 继续；不确定就别加。')
                if opts.apply and not opts.allow_hash_mismatch:
                    die('校验失败时拒绝 --apply 写库')
    print('  模式：%s' % ('★ 真实写库（--apply）' if opts.apply else '空跑（dry-run，不改动数据库）'))
    print('')

    # ── 环境预检（只读）──
    preflight(db_file, opts.table, opts.skip_integrity)

    conn = sqlite3.connect(db_file, timeout=15, isolation_level=None)
    try:
        conn.execute('PRAGMA busy_timeout = 15000')
        # 确认可写：拿一次立即写锁再放掉。失败说明旧进程仍持有未提交事务。
        try:
            conn.execute('BEGIN IMMEDIATE')
            conn.execute('ROLLBACK')
        except sqlite3.Error as err:
            die('数据库当前无法获取写锁：%s\n\n'
                '  这正是事故状态：旧进程的连接上还挂着一个永不提交的开放事务。\n'
                '  请按顺序处理：\n'
                '    1) 先存档 data/ 下的 *.db-journal / *.db-wal（那是未落盘数据的最后线索）；\n'
                '    2) 再重启服务（docker restart nestjs-app；重启即丢失内存里的那批写入）；\n'
                '    3) 然后重新运行本脚本导入。' % err)

        # ── 表结构 ──
        cols = conn.execute('PRAGMA table_info(%s)' % quote_ident(opts.table)).fetchall()
        if not cols:
            die('库里没有表 %s（schema 不对？）' % opts.table)
        by_name = dict((c[1], {'name': c[1], 'type': c[2], 'notnull': c[3], 'dflt': c[4], 'pk': c[5]})
                       for c in cols)
        print('  表 %s：%d 列' % (opts.table, len(cols)))

        # ── 字段对齐检查 ──
        json_keys = set()
        for r in bookings[:200]:
            if isinstance(r, dict):
                json_keys.update(r.keys())
        unknown_keys = sorted(k for k in json_keys if k not in by_name)
        missing_required = sorted(c['name'] for c in by_name.values()
                                  if c['notnull'] and c['dflt'] is None and c['pk'] == 0
                                  and c['name'] not in json_keys)
        if unknown_keys:
            print('  JSON 多出的字段（会被忽略）：%s' % ', '.join(unknown_keys))
        if missing_required:
            print('  表里 NOT NULL 且无默认值、JSON 里没有的列：%s' % ', '.join(missing_required))
        if (unknown_keys or missing_required) and not opts.allow_shape_drift:
            die('字段与表结构对不上，已中止（避免写入残缺行）。\n'
                '  这通常说明：JSON 来自另一版本的服务，或导错了库/表。\n'
                '  确认无误后，可加 --allow-shape-drift 强制继续。')
        print('')

        # ── 逐行决策 ──
        plan = {'insert': [], 'update': [], 'stale': [], 'conflict': [], 'bad': []}
        seen_keys = set()
        omit_id = set()  # 需要放弃导出 id、改由 sqlite 分配的行

        def holder_of(row_id):
            r = conn.execute('SELECT bookingId FROM %s WHERE id = ?' % quote_ident(opts.table),
                             (row_id,)).fetchone()
            return str(r[0]) if r else None

        for row in bookings:
            if not isinstance(row, dict):
                plan['bad'].append({'row': None, 'reason': '这一行不是对象，无法识别'})
                continue
            key = str(row['bookingId']) if row.get('bookingId') else None
            if not key:
                plan['bad'].append({'row': row, 'reason': '缺少 bookingId，无法作为主键匹配'})
                continue
            if key in seen_keys:
                plan['bad'].append({'row': row, 'reason': '导入文件内 bookingId 重复：%s' % key})
                continue
            seen_keys.add(key)

            existing = conn.execute(
                'SELECT id, updatedAt FROM %s WHERE bookingId = ?' % quote_ident(opts.table),
                (key,)).fetchone()

            if not existing:
                # 新增前先看导出 id 是否已被别的订单占用：跨快照的 id 不可信，
                # 硬写会撞主键让整行插不进去，那就丢掉 id 让 sqlite 重新分配并留痕。
                if row.get('id') is not None:
                    held_by = holder_of(row['id'])
                    if held_by and held_by != key:
                        plan['conflict'].append({'key': key, 'wantId': row['id'], 'heldBy': held_by,
                                                 'resolution': '放弃导出 id，按新 id 插入'})
                        omit_id.add(key)
                plan['insert'].append(row)
                continue

            incoming_v, existing_v = version_of(row), version_of({'updatedAt': existing[1]})
            if incoming_v is None or existing_v is None:
                # 版本号拿不到就没法判断谁更新，宁可不写也不猜
                plan['bad'].append({'row': row,
                                    'reason': 'updatedAt 无法解析，无法判断新旧，已跳过以免覆盖线上数据'})
                continue
            if incoming_v <= existing_v:
                plan['stale'].append({'key': key, 'existingId': existing[0],
                                      'incomingV': incoming_v, 'existingV': existing_v})
                continue
            plan['update'].append({'row': row, 'existingId': existing[0],
                                   'incomingV': incoming_v, 'existingV': existing_v})

        print('=== 预演结果 ===')
        print('  新增：%d' % len(plan['insert']))
        print('  更新：%d（线上版本更旧，需被覆盖）' % len(plan['update']))
        print('  跳过：%d（线上版本相同或更新，保持不动）' % len(plan['stale']))
        print('  冲突：%d（导出 id 已被别的订单占用）' % len(plan['conflict']))
        print('  异常：%d' % len(plan['bad']))
        print('')

        if plan['bad']:
            print('  [警告] 有无法处理的行，示例：')
            for b in plan['bad'][:5]:
                print('    - %s｜%s' % (b['reason'], brief(b['row'])))
            print('')

        if not opts.apply:
            report_path = write_report(opts, {'applied': False, 'in_file': in_file,
                                              'db_file': db_file, 'plan': plan})
            print('  报告：%s' % report_path)
            print('\n  这是空跑，数据库未被改动。确认上面的统计后加 --apply 真正写库。')
            return

        # ── 备份 ──
        if opts.backup:
            do_backup(conn, db_file, opts.table)

        # ── 写入 ──
        print('=== 开始写库 ===')
        stats = {'inserted': 0, 'updated': 0, 'skippedConcurrent': 0, 'errors': []}
        total = len(plan['insert']) + len(plan['update'])
        batch_size = opts.batch if opts.batch > 0 else (total + 1)
        pending = 0
        in_tx = [False]

        def begin_tx():
            if not in_tx[0]:
                conn.execute('BEGIN IMMEDIATE')
                in_tx[0] = True

        def commit_tx():
            if in_tx[0]:
                conn.execute('COMMIT')
                in_tx[0] = False

        begin_tx()
        try:
            # 插入前先 SELECT：服务若已抢先插入了同一订单，这里让路而不是把整批事务带崩。
            # （不用 ON CONFLICT ... DO NOTHING：那需要 SQLite ≥ 3.24，老机器上可能没有。
            #   我们持有 BEGIN IMMEDIATE 写锁，SELECT 与 INSERT 之间没有别的写者。）
            for row in plan['insert']:
                key = str(row.get('bookingId'))
                try:
                    if conn.execute('SELECT 1 FROM %s WHERE bookingId = ? LIMIT 1'
                                    % quote_ident(opts.table), (key,)).fetchone():
                        stats['skippedConcurrent'] += 1
                    else:
                        sql, params = build_insert(opts.table, row, by_name, key in omit_id)
                        conn.execute(sql, params)
                        stats['inserted'] += 1
                except sqlite3.Error as err:
                    stats['errors'].append({'kind': 'insert', 'bookingId': key, 'error': str(err)})
                pending += 1
                if pending >= batch_size:
                    commit_tx()
                    begin_tx()
                    pending = 0

            for item in plan['update']:
                row = item['row']
                key = str(row.get('bookingId'))
                try:
                    sql, params = build_update(opts.table, row, by_name)
                    cur = conn.execute(sql, params)
                    # rowcount=0 说明写入条件在事务里没再成立：期间有更新的版本落地了，让路是对的
                    if cur.rowcount == 0:
                        stats['skippedConcurrent'] += 1
                    else:
                        stats['updated'] += 1
                except sqlite3.Error as err:
                    stats['errors'].append({'kind': 'update', 'bookingId': key, 'error': str(err)})
                pending += 1
                if pending >= batch_size:
                    commit_tx()
                    begin_tx()
                    pending = 0

            commit_tx()
        except BaseException:
            # 出错整批回滚，绝不能把半批数据提交进去
            if in_tx[0]:
                try:
                    conn.execute('ROLLBACK')
                except sqlite3.Error:
                    pass
                in_tx[0] = False
            raise

        # ── 自增序列校正 ──
        seq_fixed = fix_sequence(conn, opts.table)

        # ── 复核 ──
        after = conn.execute('SELECT COUNT(*) FROM %s' % quote_ident(opts.table)).fetchone()[0]
        total_amount = conn.execute('SELECT SUM(amount) FROM %s' % quote_ident(opts.table)).fetchone()[0]

        print('  新增成功：%d' % stats['inserted'])
        print('  更新成功：%d' % stats['updated'])
        if stats['skippedConcurrent']:
            print('  让路跳过：%d（写入期间线上已有更新版本或已存在同一订单）' % stats['skippedConcurrent'])
        print('  失败：%d' % len(stats['errors']))
        print('  自增序列：%s' % seq_fixed)
        print('  导入后总行数：%s，amount 合计：%s' % (after, total_amount))
        if stats['errors']:
            print('\n  [警告] 有写入失败的行，示例：')
            for e in stats['errors'][:5]:
                print('    - %s %s：%s' % (e['kind'], e['bookingId'], e['error']))

        report_path = write_report(opts, {'applied': True, 'in_file': in_file, 'db_file': db_file,
                                          'plan': plan, 'stats': stats, 'after': after})
        print('\n  报告：%s' % report_path)
        print('\n  完成。建议接着核对：')
        print('    · 管理端订单列表的「总数」是否与接口报告的总数一致；')
        print('    · 抽查若干笔已支付订单的 paymentStatus / paidAt / transactionId 是否正确。')
        if stats['errors']:
            sys.exit(2)
    finally:
        conn.close()


if __name__ == '__main__':
    main()
