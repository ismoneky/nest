-- 景区导览首次上线：在 Nest 的 DATABASE_PATH 对应的主数据库中执行。
-- 执行前先备份主库；不要在日志库 logs.db 中执行。
-- 仅创建新表，可重复执行，不修改已有表和导览配置。
CREATE TABLE IF NOT EXISTS scenic_guides (
  id INTEGER PRIMARY KEY NOT NULL,
  contentJson TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updatedAt INTEGER NOT NULL
);
