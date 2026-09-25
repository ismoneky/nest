-- 服务号首版增量升级。仅执行一次；先停止服务、备份数据库。
-- 在仓库根目录使用 sqlite3 -bail <数据库路径> < docs/deploy-2026-09-21-wechat-oa.sql
-- 旧 users/messages 表必须已经存在。失败时整个事务回滚，不开启生产 synchronize。
BEGIN IMMEDIATE;

ALTER TABLE users ADD COLUMN wechatUnionId varchar;
ALTER TABLE users ADD COLUMN wechatIdentityConflict integer NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IDX_users_unionid ON users (wechatUnionId);

ALTER TABLE messages ADD COLUMN oaPayloadJson text;
ALTER TABLE messages ADD COLUMN oaNextAttemptAt integer;
ALTER TABLE messages ADD COLUMN oaExpiresAt integer;
ALTER TABLE messages ADD COLUMN oaMsgId varchar;
ALTER TABLE messages ADD COLUMN oaSkipReason varchar;
ALTER TABLE messages ADD COLUMN oaClaimedAt integer;
CREATE INDEX IDX_messages_oa_due ON messages (oaSendStatus, oaNextAttemptAt, id);

CREATE TABLE user_wx_oa (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  oaAppId varchar NOT NULL,
  oaOpenId varchar NOT NULL,
  unionId varchar,
  identityConflict integer NOT NULL DEFAULT 0,
  subscribed integer NOT NULL DEFAULT 0,
  subscriptionObservedAt integer NOT NULL,
  lastSeenRunId varchar NOT NULL,
  lastInfoAt integer,
  nextInfoRetryAt integer,
  infoAttempts integer NOT NULL DEFAULT 0,
  createdAt integer NOT NULL,
  updatedAt integer NOT NULL
);
CREATE UNIQUE INDEX IDX_user_wx_oa_openid ON user_wx_oa (oaAppId, oaOpenId);
CREATE UNIQUE INDEX IDX_user_wx_oa_unionid ON user_wx_oa (oaAppId, unionId);
CREATE INDEX IDX_user_wx_oa_seen ON user_wx_oa (oaAppId, lastSeenRunId);

CREATE TABLE wx_oa_sync_runs (
  runId varchar PRIMARY KEY NOT NULL,
  oaAppId varchar NOT NULL,
  status varchar NOT NULL,
  startedAt integer NOT NULL,
  completedAt integer,
  lastCursor varchar NOT NULL DEFAULT '',
  seenCount integer NOT NULL DEFAULT 0,
  infoSuccessCount integer NOT NULL DEFAULT 0,
  infoFailureCount integer NOT NULL DEFAULT 0,
  lastError varchar
);
CREATE INDEX IDX_wx_oa_sync_runs_status ON wx_oa_sync_runs (oaAppId, status, startedAt);

COMMIT;
