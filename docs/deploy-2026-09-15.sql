-- ============================================================================
-- 上线 SQL：fda60c3（2026-09-13「优化」）→ HEAD（6bb6801）
-- ============================================================================
--
-- 区间内容 = 「订单自动过期 + 站内信通知」这一整套（过期闭环 v2）及其之后的改动：
--   ae8b39e 阶段性优化              订单过期/退款申请/站内信（T1、refund_applies、messages）
--   9f54670 补充定时任务对外接口     管理端手动触发 T1/T2
--   0e8129e 设置回调端口             配置
--   b25396d 反馈功能，工单功能        仓库层/日志，无 schema
--   25bbc38 删除订单                 bookings.deletedByUserAt（C 端软删除）
--   6bb6801 年龄免费                 AGE_FREE_ENABLED=true，无 schema
--
-- 【执行顺序是硬约束】先执行本文件的 SQL，再发后端代码。
--   反了的话新代码会 SELECT 尚不存在的列，用户端每一次订单列表 / 详情 / 角标
--   都会 500（`SQLITE_ERROR: no such column: expiredAt` 之类）。
--   这不是理论风险：`deletedByUserAt` 已经因为漏执行 SQL 在生产上真实发生过一次。
--
-- 【安全性】全部是加列、建新表，**没有任何 UPDATE / DELETE**，不触碰一行已有数据。
--   存量订单新列均为 NULL，语义分别是「未曾过期 / 未曾通知 / 未曾核销 / 未被用户删除」。
--   本次**不需要任何数据回刷**（见文末「关于存量订单」）。
--
-- 【前置】先备份：
--   cd /app/test && cp data/test.db data/test.db.bak-$(date +%F-%H%M)
--
-- 【库路径】下面统一写 data/test.db（服务器 .env -test 的实际值）。执行前确认：
--   grep DATABASE_PATH .env
--
-- 【不用停服】旧代码不 SELECT 新列，所以「先跑 SQL、再发代码」全程不影响正在跑的旧版本。
--   两个 CREATE TABLE 与索引都是秒级，本库量级不会造成可感知的阻塞。
--
-- ============================================================================


-- ============================================================================
-- 第 0 段：前置检查（先跑，确认基线确实是 fda60c3）
-- ============================================================================
-- SQLite 没有 `ADD COLUMN IF NOT EXISTS`，重复执行会报 `duplicate column name`。
-- 该报错**无害**（表示那项早就加过了），可忽略；但先跑一遍能让你知道到底缺什么。
--
-- 期望 5 行（bookings 新列）——本次要加的就是这 5 个
-- sqlite3 data/test.db "PRAGMA table_info(bookings);" | grep -E "expiredAt|expireNotifiedAt|verifiedAt|verifiedBy|deletedByUserAt"
--
-- 期望 0 行（这两张表本次才建；若已有输出，说明 ae8b39e 早前已上过）
-- sqlite3 data/test.db "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('refund_applies','messages');"
--
-- 期望 9 行（两张新表的 9 个索引）
-- sqlite3 data/test.db "SELECT name FROM sqlite_master WHERE type='index' AND (tbl_name='refund_applies' OR tbl_name='messages');"
--
-- ⚠️ 服务器 sqlite3 CLI 版本较老：不支持 `pragma_table_info()` 表函数写法（会报
--    `near "(": syntax error`），上面用的都是 `PRAGMA table_info(...)` 老语法。
--    也不支持 `ALTER TABLE DROP COLUMN`（回滚见文末）。
--    需要程序化核对时用应用自带的驱动：
--    node -e "const s=require('sqlite3');const db=new s.Database('data/test.db',s.OPEN_READONLY);db.all('PRAGMA table_info(bookings)',[],(e,r)=>{console.log(e?e.message:r.map(c=>c.name).join(', '));db.close();});"


-- ============================================================================
-- 第 1 段：bookings 新增 5 个列
-- ============================================================================
-- 4 个过期/核销留痕（过期闭环 v2 阶段 2A）+ 1 个软删除标记（25bbc38）。
-- 全部可空、无默认值 → ADD COLUMN 只改表头元数据，不重建表、不触碰任何已有行。

ALTER TABLE bookings ADD COLUMN expiredAt integer;
ALTER TABLE bookings ADD COLUMN expireNotifiedAt integer;
ALTER TABLE bookings ADD COLUMN verifiedAt integer;
ALTER TABLE bookings ADD COLUMN verifiedBy varchar;
ALTER TABLE bookings ADD COLUMN deletedByUserAt integer;

-- 一次性写法：
-- sqlite3 data/test.db "ALTER TABLE bookings ADD COLUMN expiredAt integer; ALTER TABLE bookings ADD COLUMN expireNotifiedAt integer; ALTER TABLE bookings ADD COLUMN verifiedAt integer; ALTER TABLE bookings ADD COLUMN verifiedBy varchar; ALTER TABLE bookings ADD COLUMN deletedByUserAt integer;"

-- 字段含义：
--   expiredAt         被 T1 翻转为 expired 的时刻。**退款申请 7 天时限的计算基准**
--   expireNotifiedAt  「已过期」通知已发出的时刻。防漏发的标记位（NULL = 未通知，下轮继续扫到）
--   verifiedAt        核销时刻。新增核销留痕（此前核销不留任何记录，与定时任务刷出来的
--                     completed 事后无法区分——这正是 completed 语义收窄的前提）
--   verifiedBy        核销人 openid
--   deletedByUserAt   用户在小程序端删除该订单的时刻。只影响**用户侧可见性**：
--                     用户列表、角标计数、订单详情、退款申请入口、三个扫描类通知的取单查询。
--                     后台列表/导出/看板、资金链路、核销、名额与统计**一律不过滤**。

-- ⚠️ **不要建索引**。方案 §5.2 让建的 idx_bookings_status_date_time 与
--    idx_bookings_expire_notify 都已核实为冗余/无收益（理由见 implementation-todo.md
--    第 7b 节，含 EXPLAIN 实测方法）。deletedByUserAt 同理：用户侧列表走既有的
--    wechatOpenId 索引，IS NULL 只是过滤条件。本库是 SQLite 单写者，无 EXPLAIN 证据不加索引。


-- ============================================================================
-- 第 2 段：新建 refund_applies 退款申请单表
-- ============================================================================
-- 索引名是实体里**显式指定**的（@Index('IDX_...')），必须与此处逐字一致；
-- 否则会出现「开发库有索引、生产库也有，但名字不同」的隐性漂移。

CREATE TABLE IF NOT EXISTS refund_applies (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  applyNo varchar NOT NULL,
  bookingId varchar NOT NULL,
  wechatOpenId varchar NOT NULL,
  applyCount integer NOT NULL,
  reason varchar(500) NOT NULL,
  status varchar NOT NULL DEFAULT 'pending',
  refundAmount integer NOT NULL,
  outRefundNo varchar,
  auditAdminId integer,
  auditAdminName varchar,
  auditAt integer,
  auditRemark varchar,
  rejectReason varchar(500),
  createdAt integer NOT NULL DEFAULT (strftime('%s','now') * 1000),
  updatedAt integer NOT NULL DEFAULT (strftime('%s','now') * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS IDX_refund_applies_applyNo ON refund_applies (applyNo);
CREATE UNIQUE INDEX IF NOT EXISTS IDX_refund_applies_booking_count ON refund_applies (bookingId, applyCount);
CREATE INDEX IF NOT EXISTS IDX_refund_applies_status_created ON refund_applies (status, createdAt);
CREATE INDEX IF NOT EXISTS IDX_refund_applies_user ON refund_applies (wechatOpenId, createdAt);
CREATE INDEX IF NOT EXISTS IDX_refund_applies_out_refund_no ON refund_applies (outRefundNo);

-- 不做外键：本库整体无外键，申请单与订单的关联由应用层保证。
-- 本表是新增表，不动 bookings 一行数据。
-- (bookingId, applyCount) 的唯一索引是**并发重复提交的最终兜底**，不要省。


-- ============================================================================
-- 第 3 段：新建 messages 站内信表
-- ============================================================================
-- 三个 oa* 列本期不写入任何业务逻辑（OA_ENABLED=false），但必须先建：
-- 服务号分支（feat/oa-template-message）落地时只改代码、不碰 schema。

CREATE TABLE IF NOT EXISTS messages (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  userId varchar NOT NULL,
  msgType varchar NOT NULL,
  title varchar NOT NULL,
  content varchar(500) NOT NULL,
  bizType varchar,
  bizId varchar,
  jumpPath varchar,
  senderType varchar NOT NULL DEFAULT 'SYSTEM',
  adminId integer,
  dedupeKey varchar,
  oaSendStatus integer NOT NULL DEFAULT 3,
  oaAttempts integer NOT NULL DEFAULT 0,
  oaLastError varchar,
  isRead integer NOT NULL DEFAULT 0,
  readAt integer,
  createdAt integer NOT NULL DEFAULT (strftime('%s','now') * 1000),
  updatedAt integer NOT NULL DEFAULT (strftime('%s','now') * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS IDX_messages_dedupe ON messages (dedupeKey);
CREATE INDEX IF NOT EXISTS IDX_messages_user_read ON messages (userId, isRead, id);
CREATE INDEX IF NOT EXISTS IDX_messages_user_type ON messages (userId, msgType, createdAt);
CREATE INDEX IF NOT EXISTS IDX_messages_oa_retry ON messages (oaSendStatus, oaAttempts);

-- ⚠️ dedupeKey 的唯一索引靠 SQLite「唯一索引下多个 NULL 互不冲突」的特性，
--    让 ADMIN_NOTICE（dedupeKey 为 NULL）能无限多条。**不要改成 '' 或 0**。
--    userId 存的是 **wechatOpenId**，不是 users.id。
-- ⚠️ dedupeKey 的格式是 `{msgType}:{业务ID}`，退款类必须带 **applyNo** 而非 bookingId
--    —— 用 bookingId 的话，同一订单第 2、3 次申请的 key 完全相同，第二条起被静默去重，
--    用户永远收不到审核结果（v1 的真实缺陷）。改这个格式前先看 message-templates.ts。


-- ============================================================================
-- 第 4 段：上线后自检
-- ============================================================================
-- 1) 库结构：此时第 0 段的三条检查应分别输出 5 行 / 2 行 / 9 行
--
-- 2) 索引计划（implementation-todo.md 第 7b 节的规矩：用 EXPLAIN 而不是猜）
--    sqlite3 data/test.db "EXPLAIN QUERY PLAN SELECT id FROM bookings WHERE status='confirmed' AND bookingDate < date('now') AND refundStatus NOT IN ('refunding','refunded');"
--    预期走 idx_bookings_status_date（fda60c3 时已建）。
--
-- 3) 链路冒烟（在临时库上跑，不碰生产库，可重复执行）：
--    npm run smoke:expire      # 预期 21/21
--
-- 4) 启动后确认两个新 Cron 已注册：
--    T1 过期扫描  每小时 :13      T2 每日提醒  每天 22:00
--    首次 T1 运行后查一眼：sqlite3 data/test.db "SELECT COUNT(*) FROM bookings WHERE status='expired';"
--    稳态下这个数应该等于「近几天过期未核销」的量级（几十单），不该是四位数。
--
-- 5) 站内信是否真的发出：
--    sqlite3 data/test.db "SELECT msgType, COUNT(*) FROM messages GROUP BY msgType;"
--
-- 6) 端到端：小程序打开订单列表与详情、管理端打开订单列表 / 退款审核页 / 定时任务页。


-- ============================================================================
-- 关于存量订单（本次不需要回刷，但有一件不可逆的事要说清）
-- ============================================================================
-- T1 的判据是 `status='confirmed' AND bookingDate < 今天`。存量订单里：
--   · 已经被旧 Cron 刷成 `completed` 的（历史「没来」的人）**不会**变成 `expired`。
--     它们在库里与「真来过」无法区分，且永远不会进入退款申请流程。
--     这是 completed 语义收窄的**不可逆部分**，已在 implementation-todo.md 第 17 条记录。
--   · 仍挂在 `confirmed` 且日期已过的（旧 Cron 每 5 分钟扫一次，正常应为 0 单）：
--     上线后第一次 T1 会把这批翻成 `expired` 并发通知。**上线前先查一眼**：
--     sqlite3 data/test.db "SELECT COUNT(*) FROM bookings WHERE status='confirmed' AND bookingDate < date('now');"
--     如果这个数很大（说明旧 Cron 早就没在正常工作），第一次扫描会一次性给这批用户发通知
--     —— 通知本身没有单轮条数上限（2026-09-15 已移除 200 条限制），量级大时会占用
--     SQLite 单写者一段时间。先看数，再决定要不要挑个低峰时段发版。


-- ============================================================================
-- 回滚
-- ============================================================================
-- ⚠️ 服务器 sqlite3 CLI 版本较老，**不支持 ALTER TABLE DROP COLUMN**（需 3.35+）。
--    真要回滚，用应用侧 node 驱动执行，或从第 0 段的备份整体还原。
--
-- DROP TABLE IF EXISTS messages;        -- 纯记录层，删表不影响订单与资金
-- DROP TABLE IF EXISTS refund_applies;  -- 回滚前先确认没有 status='approved' 的在途申请单：
--                                       --   SELECT applyNo, bookingId, outRefundNo FROM refund_applies WHERE status='approved';
--                                       -- 删表会让用户在审核队列里的待办全部丢失（不可逆）
-- ALTER TABLE bookings DROP COLUMN deletedByUserAt;   -- 会让被用户删掉的订单重新回到用户列表
-- ALTER TABLE bookings DROP COLUMN verifiedBy;
-- ALTER TABLE bookings DROP COLUMN verifiedAt;
-- ALTER TABLE bookings DROP COLUMN expireNotifiedAt;  -- ⚠️ 不要清这个：它记录「已经打扰过用户了」，
--                                                     -- 清了会导致重新上线时给全部历史订单补发一遍通知
-- ALTER TABLE bookings DROP COLUMN expiredAt;
--
-- 各段详细影响见 implementation-todo.md 第 7c / 8b / 9b / 10b 节。
