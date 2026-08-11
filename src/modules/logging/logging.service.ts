import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { existsSync, statSync } from 'fs';
import { AppLog, AppLogLevel, AppLogSource, AppLogCategory } from '../../entities/app-log.entity';
import { filterContext } from './sensitive-filter';
import { getCurrentRequestId } from './request-context';

/**
 * 日志条目（AppLogWriter 接口输入）
 */
export type LogEntry = {
    source: AppLogSource;
    level: AppLogLevel;
    category: AppLogCategory;
    message: string;
    sessionId?: string;
    route?: string;
    context?: unknown;
    appVersion?: string;
    platform?: string;
    clientCreatedAt?: number;
};

/**
 * AppLogWriter：对业务代码提供的小接口（logging-design.md）
 * write/writeMany 进入内存队列后即 resolve，不代表已落盘；
 * persistClientBatch 等待批次真实提交后才确认 acceptedLogIds。
 */
export interface AppLogWriter {
    write(entry: LogEntry): Promise<void>;
    writeMany(entries: LogEntry[]): Promise<void>;
    persistClientBatch(entries: LogEntry[]): Promise<{ acceptedLogIds: string[] }>;
}

/**
 * 后端业务日志队列最大条数
 */
const BACKEND_QUEUE_MAX = 500;

/**
 * 单次批量 INSERT 条数（写事务大小）
 */
const FLUSH_BATCH_SIZE = 20;

/**
 * 队列未满时最老日志等待刷盘的时间（毫秒）
 */
const FLUSH_INTERVAL_MS = 5000;

/**
 * 后端非关键日志在队列中等待写盘的最长时间（毫秒），超过按淘汰规则丢弃
 */
const QUEUE_RETRY_TTL_MS = 30 * 1000;

/**
 * 日志级别淘汰排序（越小越先被淘汰）
 */
const LEVEL_RANK: Record<AppLogLevel, number> = {
    [AppLogLevel.DEBUG]: 0,
    [AppLogLevel.INFO]: 1,
    [AppLogLevel.WARN]: 2,
    [AppLogLevel.ERROR]: 3,
};

/**
 * logs.db 体积监控阈值（默认 512 MiB，可通过 LOG_DB_SIZE_WARN_MB 调整）
 */
const LOG_DB_SIZE_WARN_BYTES = (parseInt(process.env.LOG_DB_SIZE_WARN_MB ?? '512', 10) || 512) * 1024 * 1024;

/**
 * 日志保留时长（默认 30 天）
 */
const LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

type QueuedLog = { entry: AppLog; queuedAt: number };

/**
 * 轻量日志服务：独立 logs.db 的串行 writer。
 * 所有 SQLite 日志写入通过进程内 writer 队列串行执行，同一时刻最多一个日志事务。
 * 日志写入失败绝不改变预约/支付业务结果。
 */
@Injectable()
export class LoggingService implements AppLogWriter, OnModuleInit {
    private readonly logger = new Logger(LoggingService.name);

    /** SQLite 日志持久化开关（APP_LOG_SQLITE_ENABLED=false 时回退 Nest stdout） */
    private sqliteEnabled = process.env.APP_LOG_SQLITE_ENABLED !== 'false';

    private queue: QueuedLog[] = [];
    private flushTimer: NodeJS.Timeout | null = null;
    private writeChain: Promise<unknown> = Promise.resolve();

    private busyWarnedAt = 0;
    private droppedWarnedAt = 0;
    private sizeWarnedAt = 0;

    constructor(
        @InjectRepository(AppLog, 'logs')
        private readonly appLogRepository: Repository<AppLog>,
    ) {}

    async onModuleInit() {
        // 启动时校验 logs.db schema：失败则禁用 SQLite 日志并回退 stdout，不影响业务启动
        if (!this.sqliteEnabled) {
            this.logger.warn('APP_LOG_SQLITE_ENABLED=false，SQLite 日志持久化已禁用');
            return;
        }
        try {
            const table = await this.appLogRepository.manager.query(
                `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_logs'`,
            );
            const indexes = await this.appLogRepository.manager.query(
                `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'app_logs'`,
            );
            if (table.length === 0) {
                throw new Error('app_logs 表不存在（请先执行 logs.db 初始化 SQL，见 docs/implementation-todo.md）');
            }
            if (indexes.length < 6) {
                throw new Error('app_logs 索引不完整（请对照初始化 SQL 补齐索引）');
            }
            this.logger.log(`logs.db schema 校验通过（${indexes.length} 个索引）`);
        } catch (error) {
            this.sqliteEnabled = false;
            this.logger.error(`logs.db schema 校验失败，SQLite 日志已禁用并回退 stdout（不影响预约/支付）: ${error.message}`);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // AppLogWriter 接口
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * 写一条后端业务日志：进入内存队列后即 resolve，不等待 SQLite
     */
    async write(entry: LogEntry): Promise<void> {
        if (!this.sqliteEnabled) {
            this.logToStdout(entry);
            return;
        }
        const row = this.buildRow(entry);
        this.enqueue([row]);
    }

    /**
     * 批量写后端业务日志：每次最多接受 20 条，更多必须由调用方拆批
     */
    async writeMany(entries: LogEntry[]): Promise<void> {
        if (entries.length > FLUSH_BATCH_SIZE) {
            throw new Error(`writeMany 每次最多接受 ${FLUSH_BATCH_SIZE} 条日志，请由调用方拆批`);
        }
        if (!this.sqliteEnabled) {
            for (const entry of entries) {
                this.logToStdout(entry);
            }
            return;
        }
        this.enqueue(entries.map((entry) => this.buildRow(entry)));
    }

    /**
     * 小程序批量上报：等待批次真实提交后才确认 acceptedLogIds（最多等 3 秒）
     * SQLite writer 繁忙、队列已满或超过等待时间时抛错，由 controller 转 503
     */
    async persistClientBatch(entries: LogEntry[]): Promise<{ acceptedLogIds: string[] }> {
        if (!this.sqliteEnabled) {
            throw new Error('SQLite 日志持久化已禁用');
        }
        const rows = entries.map((entry) => this.buildRow(entry));

        // 串行 writer 中插入并等待完成（INSERT OR IGNORE：重复 logId 幂等，重复视为已接受）
        const writePromise = this.enqueueWrite(async () => {
            await this.insertBatch(rows);
        });
        await this.withTimeout(writePromise, 3000, '日志 writer 繁忙或超时');

        return { acceptedLogIds: rows.map((row) => row.logId) };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 内部实现
    // ─────────────────────────────────────────────────────────────────────────

    private buildRow(entry: LogEntry): AppLog {
        const filtered = filterContext(entry.context);
        const row = new AppLog();
        row.logId = `L${randomUUID().replace(/-/g, '').substring(0, 20)}`;
        row.source = entry.source;
        row.level = entry.level;
        row.category = entry.category;
        row.message = entry.message.length > 2000 ? entry.message.substring(0, 2000) : entry.message;
        row.requestId = getCurrentRequestId();
        row.sessionId = entry.sessionId ?? null;
        row.route = entry.route ?? null;
        row.contextJson = filtered.json;
        row.appVersion = entry.appVersion ?? null;
        row.platform = entry.platform ?? null;
        row.clientCreatedAt = entry.clientCreatedAt ?? null;
        row.createdAt = Date.now();
        return row;
    }

    private enqueue(rows: AppLog[]) {
        for (const row of rows) {
            this.queue.push({ entry: row, queuedAt: Date.now() });
        }
        this.evictIfFull();
        this.scheduleFlush();
    }

    /**
     * 队列满时按级别淘汰：优先保留较新且级别更高的日志
     */
    private evictIfFull() {
        if (this.queue.length <= BACKEND_QUEUE_MAX) {
            return;
        }
        const droppedCount = this.queue.length - BACKEND_QUEUE_MAX;
        for (let d = 0; d < droppedCount; d++) {
            let idx = 0;
            for (let i = 1; i < this.queue.length; i++) {
                if (LEVEL_RANK[this.queue[i].entry.level] < LEVEL_RANK[this.queue[idx].entry.level]) {
                    idx = i;
                }
            }
            this.queue.splice(idx, 1);
        }
        const now = Date.now();
        if (now - this.droppedWarnedAt > 60 * 1000) {
            this.droppedWarnedAt = now;
            this.logger.warn(`后端日志队列已满，按级别淘汰 ${droppedCount} 条（限频）`);
        }
    }

    private scheduleFlush() {
        if (this.flushTimer || this.queue.length === 0) {
            return;
        }
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this.flushQueue();
        }, FLUSH_INTERVAL_MS);
        this.flushTimer.unref();
    }

    /**
     * 刷盘：一批最多 20 条，通过串行 writer 单事务提交。
     * SQLITE_BUSY 等失败时批次放回队列等待下一轮；等待超过 30 秒仍未写入的按淘汰规则丢弃。
     */
    private flushQueue() {
        if (!this.sqliteEnabled || this.queue.length === 0) {
            return;
        }
        const now = Date.now();
        const stale = this.queue.filter((q) => now - q.queuedAt > QUEUE_RETRY_TTL_MS);
        if (stale.length > 0) {
            this.queue = this.queue.filter((q) => now - q.queuedAt <= QUEUE_RETRY_TTL_MS);
            if (now - this.droppedWarnedAt > 60 * 1000) {
                this.droppedWarnedAt = now;
                this.logger.warn(`后端日志队列超时未写入，丢弃 ${stale.length} 条（限频）`);
            }
        }
        if (this.queue.length === 0) {
            return;
        }
        const batch = this.queue.splice(0, FLUSH_BATCH_SIZE);
        this.enqueueWrite(async () => {
            try {
                await this.insertBatch(batch.map((b) => b.entry));
            } catch (error) {
                // SQLITE_BUSY 等：保留在内存队列等待下一轮，不阻塞主流程
                this.queue.unshift(...batch);
                if (now - this.busyWarnedAt > 60 * 1000) {
                    this.busyWarnedAt = now;
                    this.logger.warn(`日志写入失败，批次保留待重试（限频）: ${error.message}`);
                }
            }
        });
        this.scheduleFlush();
    }

    /**
     * 串行 SQLite writer：同一时刻最多一个日志事务
     */
    private enqueueWrite(task: () => Promise<unknown>): Promise<unknown> {
        const result = this.writeChain.then(task, task);
        this.writeChain = result.catch(() => undefined);
        return result;
    }

    /**
     * 单条批量 INSERT（INSERT OR IGNORE：logId 唯一索引幂等去重）
     */
    private async insertBatch(rows: AppLog[]) {
        await this.appLogRepository
            .createQueryBuilder()
            .insert()
            .values(rows)
            .orIgnore()
            .execute();
    }

    private async withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(message)), ms);
            timer.unref();
            promise.then(
                (value) => {
                    clearTimeout(timer);
                    resolve(value);
                },
                (error) => {
                    clearTimeout(timer);
                    reject(error);
                },
            );
        });
    }

    /**
     * SQLite 日志禁用时的回退：Nest stdout（限频）
     */
    private logToStdout(entry: LogEntry) {
        if (this.logger.isLevelEnabled(entry.level as any)) {
            const line = `[${entry.source}/${entry.category}] ${entry.message}`;
            switch (entry.level) {
                case AppLogLevel.ERROR:
                    this.logger.error(line);
                    break;
                case AppLogLevel.WARN:
                    this.logger.warn(line);
                    break;
                case AppLogLevel.DEBUG:
                    this.logger.debug(line);
                    break;
                default:
                    this.logger.log(line);
                    break;
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 管理后台查询
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * 管理查询 QueryBuilder 基础（controller 在此基础上追加筛选条件）
     */
    queryLogsBuilder() {
        return this.appLogRepository.createQueryBuilder('log');
    }

    /**
     * 基础统计：总量、按来源数量、按级别数量、最近错误数（时间范围内）
     */
    async computeStats(start?: string, end?: string): Promise<{
        total: number;
        bySource: Record<string, number>;
        byLevel: Record<string, number>;
        recentErrors: number;
    }> {
        const qb = this.appLogRepository.createQueryBuilder('log');
        if (start) {
            const s = new Date(start);
            s.setHours(0, 0, 0, 0);
            qb.andWhere('log.createdAt >= :start', { start: s.getTime() });
        }
        if (end) {
            const e = new Date(end);
            e.setHours(23, 59, 59, 999);
            qb.andWhere('log.createdAt <= :end', { end: e.getTime() });
        }

        const total = await qb.clone().getCount();

        const bySourceRows = await qb
            .clone()
            .select('log.source', 'source')
            .addSelect('COUNT(*)', 'count')
            .groupBy('log.source')
            .getRawMany();
        const bySource: Record<string, number> = {};
        for (const row of bySourceRows) {
            bySource[row.source] = Number(row.count);
        }

        const byLevelRows = await qb
            .clone()
            .select('log.level', 'level')
            .addSelect('COUNT(*)', 'count')
            .groupBy('log.level')
            .getRawMany();
        const byLevel: Record<string, number> = {};
        for (const row of byLevelRows) {
            byLevel[row.level] = Number(row.count);
        }

        const recentErrors = await qb
            .clone()
            .andWhere('log.level = :level', { level: AppLogLevel.ERROR })
            .getCount();

        return { total, bySource, byLevel, recentErrors };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 保留与清理
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * 每日低峰期清理过期日志：03:21 Asia/Shanghai（与所有对账任务分钟错开）
     * 每批最多删除 200 条，批次间隔至少 100ms，每日单轮最多执行 10 批
     */
    @Cron('0 21 3 * * *', { timeZone: 'Asia/Shanghai' })
    async runLogCleanup() {
        if (!this.sqliteEnabled) {
            return;
        }
        const cutoff = Date.now() - LOG_RETENTION_MS;
        let totalDeleted = 0;
        const startedAt = Date.now();
        try {
            for (let batch = 0; batch < 10; batch++) {
                const result = await this.appLogRepository
                    .createQueryBuilder()
                    .delete()
                    .where('createdAt < :cutoff', { cutoff })
                    .limit(200)
                    .execute();
                const deleted = result.affected ?? 0;
                totalDeleted += deleted;
                if (deleted < 200) {
                    break;
                }
                // 批次间隔至少 100ms，避免长事务阻塞 SQLite
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            this.logger.log(`日志清理完成: 删除 ${totalDeleted} 条，耗时 ${Date.now() - startedAt}ms`);
        } catch (error) {
            // 清理失败仅记录，下一日重试
            this.logger.error(`日志清理失败: ${error.message}`);
        }
    }

    /**
     * 每小时检查 logs.db 文件大小：达到阈值输出限频告警并优先执行过期日志清理
     */
    @Cron('0 5 * * * *', { timeZone: 'Asia/Shanghai' })
    async checkLogDbSize() {
        if (!this.sqliteEnabled) {
            return;
        }
        const dbPath = process.env.LOG_DATABASE_PATH || 'data/logs.db';
        try {
            if (!existsSync(dbPath)) {
                return;
            }
            const size = statSync(dbPath).size;
            const now = Date.now();
            if (size > LOG_DB_SIZE_WARN_BYTES && now - this.sizeWarnedAt > 10 * 60 * 1000) {
                this.sizeWarnedAt = now;
                this.logger.warn(`logs.db 体积达到 ${(size / 1024 / 1024).toFixed(0)} MiB，超过 ${LOG_DB_SIZE_WARN_BYTES / 1024 / 1024} MiB 阈值，优先执行过期日志清理`);
            }
            if (size > LOG_DB_SIZE_WARN_BYTES) {
                await this.runLogCleanup();
            }
        } catch (error) {
            this.logger.warn(`logs.db 体积检查失败: ${error.message}`);
        }
    }
}
