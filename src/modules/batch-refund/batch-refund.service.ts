import { Injectable, BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { OnModuleInit } from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';
import { randomUUID } from 'crypto';
import { BookingRepository } from '../../repositories/booking.repository';
import { BatchRefundTaskRepository } from '../../repositories/batch-refund-task.repository';
import { BatchRefundTask, BatchRefundTaskStatus } from '../../entities/batch-refund-task.entity';
import { WechatPayService } from '../wechat-pay/wechat-pay.service';
import { LoggingService } from '../logging/logging.service';
import { AppLogLevel, AppLogSource, AppLogCategory } from '../../entities/app-log.entity';
import { REFUND_BUCKET_LABELS, RefundBucket } from './refund-eligibility';

/**
 * 批量退款相邻微信请求启动间隔（设计 2.12：至少 300ms，并发 1）
 */
const BATCH_REFUND_REQUEST_INTERVAL_MS = 300;

/**
 * Cron 兜底：RUNNING 任务心跳超过该时长视为无活跃 worker（设计 2.8：每 10 分钟检查）
 */
const WORKER_STALE_MS = 10 * 60 * 1000;

/**
 * worker 单轮时间预算：超时停止领取新订单，已开始的请求正常收尾后由 Cron/恢复逻辑续跑
 */
const WORKER_TIME_BUDGET_MS = 9 * 60 * 1000;

/**
 * 批量退款服务
 *
 * - 任务创建与订单冻结同事务（BEGIN IMMEDIATE），affected=0 回滚返回 400
 * - 单 worker 串行提交：并发 1、相邻请求间隔 ≥300ms、固定 outRefundNo
 * - 进度按 bookings 实时聚合，不维护第二套计数
 */
@Injectable()
export class BatchRefundService implements OnModuleInit {
    private readonly logger = new Logger(BatchRefundService.name);

    /** 同进程防重入（非最终一致性保证，数据库唯一约束才是） */
    private runningTaskId: string | null = null;

    constructor(
        private readonly bookingRepo: BookingRepository,
        private readonly taskRepo: BatchRefundTaskRepository,
        private readonly wechatPayService: WechatPayService,
        private readonly loggingService: LoggingService,
        private readonly dataSource: DataSource,
    ) {}

    /**
     * 应用启动恢复：查询 RUNNING 任务并继续其 PENDING 订单（设计 2.8）
     */
    async onModuleInit() {
        // 退款回调后的任务状态重算挂钩（尽力而为，见 wechat-pay.service handleRefundCallback）
        this.wechatPayService.batchRefundRecalc = async (taskId: string) => {
            const task = await this.taskRepo.findByTaskId(taskId);
            if (task) await this.recalcTaskStatus(task);
        };

        try {
            const running = await this.taskRepo.findRunningTask();
            if (running) {
                this.logger.log(`启动恢复批量退款任务: ${running.taskId}`);
                this.startWorker(running.taskId);
            }
            // SUBMISSION_COMPLETED 任务只等回调和对账，无需启动 worker；
            // 终态推进由 Cron 兜底扫描
            const submissionCompleted = await this.taskRepo.findRecentTasks(50);
            for (const task of submissionCompleted) {
                if (task.status === BatchRefundTaskStatus.SUBMISSION_COMPLETED) {
                    await this.recalcTaskStatus(task).catch(() => undefined);
                }
            }
        } catch (error) {
            this.logger.error('批量退款启动恢复失败', error);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 预览
    // ─────────────────────────────────────────────────────────────────────────

    async preview(bookingIds: string[]) {
        if (!bookingIds?.length) {
            throw new BadRequestException('未选择订单');
        }
        const now = Date.now();
        const { refundable, unrefundable, detailPreview } = await this.bookingRepo.getBatchRefundPreview(bookingIds, now);

        const runningTask = await this.taskRepo.findRunningTask();
        let running: { taskId: string; pending: number; total: number } | null = null;
        if (runningTask) {
            const progress = await this.bookingRepo.aggregateBatchRefundProgress(runningTask.taskId);
            running = { taskId: runningTask.taskId, pending: progress.pending, total: progress.total };
        }

        return {
            refundable,
            unrefundable: unrefundable.map((b) => ({ ...b, label: REFUND_BUCKET_LABELS[b.reason as Exclude<RefundBucket, 'refundable'>] ?? b.reason })),
            detailPreview,
            runningTask: running,
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 执行（事务创建任务 + 冻结订单）
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * 执行选择性批量退款（设计 2.4）
     * 事务：检查 RUNNING → 建任务 → 按管理员资金条件对勾选订单批量冻结 → totalTarget=affected
     * 事务内只做本地数据库操作，绝不调微信；冻结不排对账（PENDING 恢复只走 worker + Cron）。
     */
    async execute(bookingIds: string[], reason: string, operatorAdminId: string) {
        if (!bookingIds?.length) {
            throw new BadRequestException('未选择订单');
        }
        // 先做一次快速检查，已有 RUNNING 任务直接 409（带 taskId），避免无谓事务
        const existing = await this.taskRepo.findRunningTask();
        if (existing) {
            throw new ConflictException({ message: '已有正在执行的批量退款任务', taskId: existing.taskId });
        }

        const taskId = `BRT${randomUUID().replace(/-/g, '').substring(0, 12).toUpperCase()}`;
        const now = Date.now();

        let totalTarget: number;
        try {
            totalTarget = await this.dataSource.transaction(async (em) => {
                // SQLite 写锁冲突时等待 5 秒（连接级设置，与 app.module 的 busyTimeout 对齐）
                await em.query('PRAGMA busy_timeout = 5000');
                // 二次检查（事务内）：并发请求只有一个能通过；生产另有 RUNNING 部分唯一索引兜底
                const runningRows: any[] = await em.query(
                    `SELECT taskId FROM batch_refund_tasks WHERE status = 'RUNNING' LIMIT 1`,
                );
                if (runningRows.length > 0) {
                    throw new ConflictException({ message: '已有正在执行的批量退款任务', taskId: runningRows[0].taskId });
                }

                const task = new BatchRefundTask();
                task.taskId = taskId;
                task.status = BatchRefundTaskStatus.RUNNING;
                task.reason = reason;
                task.operatorAdminId = operatorAdminId;
                task.totalTarget = 0;
                await em.save(task);

                const affected = await this.bookingRepo.freezeBookingsForBatchRefund(em, bookingIds, taskId, now);
                if (affected === 0) {
                    throw new BadRequestException('所选订单中没有符合条件的可退订单');
                }
                task.totalTarget = affected;
                // 选择摘要：实际冻结订单的去重预约日期（审计展示用，截断 100 字符）
                const dateRows: Array<{ bookingDate: string }> = await em.query(
                    `SELECT DISTINCT bookingDate FROM bookings WHERE refundBatchTaskId = ? LIMIT 20`,
                    [taskId],
                );
                task.selectionSummary = dateRows.map((r) => r.bookingDate).join(',').substring(0, 100) || null;
                await em.save(task);
                return affected;
            });
        } catch (error) {
            // 生产唯一部分索引 IDX_batch_refund_tasks_running 兜底拦截的并发插入：
            // 转为设计约定的 409 + 当前 taskId，不暴露 500
            if (error instanceof QueryFailedError && typeof error.message === 'string' && error.message.includes('UNIQUE constraint failed')) {
                const running = await this.taskRepo.findRunningTask();
                if (running) {
                    throw new ConflictException({ message: '已有正在执行的批量退款任务', taskId: running.taskId });
                }
            }
            throw error;
        }

        this.loggingService.write({
            source: AppLogSource.BACKEND,
            level: AppLogLevel.INFO,
            category: AppLogCategory.PAYMENT,
            message: '批量退款任务已创建',
            route: '/admin/batch-refund/execute',
            context: { taskId, selected: bookingIds.length, totalTarget, operatorAdminId },
        });

        // 事务提交后立即启动 worker（不 await，不阻塞响应）
        this.startWorker(taskId);

        return { taskId, totalTarget, status: BatchRefundTaskStatus.RUNNING };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 任务查询
    // ─────────────────────────────────────────────────────────────────────────

    async listTasks(limit = 20) {
        const tasks = await this.taskRepo.findRecentTasks(limit);
        return tasks.map((t) => this.serializeTask(t));
    }

    async getTask(taskId: string) {
        const task = await this.taskRepo.findByTaskId(taskId);
        if (!task) {
            throw new BadRequestException('任务不存在');
        }
        const progress = await this.bookingRepo.aggregateBatchRefundProgress(taskId);
        return { ...this.serializeTask(task), progress };
    }

    private serializeTask(task: BatchRefundTask) {
        return {
            taskId: task.taskId,
            selectionSummary: task.selectionSummary ?? null,
            status: task.status,
            totalTarget: task.totalTarget,
            reason: task.reason,
            operatorAdminId: task.operatorAdminId,
            createdAt: task.createdAt?.getTime() ?? null,
            startedAt: task.startedAt?.getTime() ?? null,
            submissionCompletedAt: task.submissionCompletedAt?.getTime() ?? null,
            completedAt: task.completedAt?.getTime() ?? null,
            errorSummary: task.errorSummary ?? null,
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // worker（串行提交）
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * 启动 worker（同进程防重入；数据库 RUNNING 唯一性是最终保证）
     */
    startWorker(taskId: string) {
        if (this.runningTaskId === taskId) return;
        this.runningTaskId = taskId;
        this.runWorker(taskId).catch((error) => {
            this.logger.error(`批量退款 worker 异常退出: ${taskId}`, error);
        }).finally(() => {
            if (this.runningTaskId === taskId) this.runningTaskId = null;
        });
    }

    private async runWorker(taskId: string) {
        const task = await this.taskRepo.findByTaskId(taskId);
        if (!task || task.status !== BatchRefundTaskStatus.RUNNING) return;

        const startedAt = Date.now();
        if (!task.startedAt) {
            task.startedAt = new Date();
        }
        const errorCounts = new Map<string, number>();
        let lastRequestAt = 0;

        try {
            // 循环领取当前任务下一笔 PENDING 订单，一次一笔（设计 2.6）
            for (;;) {
                if (Date.now() - startedAt > WORKER_TIME_BUDGET_MS) {
                    // 超预算：交还 Cron 兜底续跑（心跳已停，下轮 10 分钟内恢复）
                    this.logger.warn(`批量退款任务 ${taskId} 超出单轮时间预算，等待 Cron 续跑`);
                    return;
                }

                const booking = await this.bookingRepo.claimNextPendingBooking(taskId);
                if (!booking) break; // 已无 PENDING

                // 相邻请求启动间隔至少 300ms
                const wait = BATCH_REFUND_REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt);
                if (wait > 0) await new Promise((r) => setTimeout(r, wait));
                lastRequestAt = Date.now();

                await this.touchHeartbeat(taskId);

                // 固定退款单号（冻结时已写 outRefundNo，此处必有值；防御性回退）
                const outRefundNo = booking.outRefundNo ?? `RF${booking.bookingId}`;

                // 调微信退款（batchRefundAgent 并发 1；HTTP 绝不在 SQLite 事务内）
                const result = await this.wechatPayService.refund(
                    booking.outTradeNo,
                    outRefundNo,
                    booking.amount,
                    booking.amount,
                    { reason: task.reason, agent: this.wechatPayService.batchRefundAgent },
                );

                const now = Date.now();
                if (result.state === 'accepted') {
                    await this.bookingRepo.markRefundSubmitted(booking.bookingId, now);
                } else if (result.state === 'rejected') {
                    await this.bookingRepo.markRefundSubmitFailed(booking.bookingId, result.code);
                    errorCounts.set(result.code, (errorCounts.get(result.code) ?? 0) + 1);
                } else {
                    await this.bookingRepo.markRefundSubmitUnknown(booking.bookingId, result.code, now);
                    errorCounts.set(result.code, (errorCounts.get(result.code) ?? 0) + 1);
                }
            }

            // 当前任务已无 PENDING → SUBMISSION_COMPLETED
            await this.markSubmissionCompleted(taskId, errorCounts);
        } catch (error) {
            // worker 异常退出：任务保持 RUNNING，心跳停更，Cron 兜底恢复
            this.logger.error(`批量退款 worker 执行中断: ${taskId}`, error);
            this.loggingService.write({
                source: AppLogSource.BACKEND,
                level: AppLogLevel.ERROR,
                category: AppLogCategory.PAYMENT,
                message: '批量退款 worker 执行中断',
                route: 'batch-refund-worker',
                context: { taskId, error: (error as Error)?.message },
            });
            throw error;
        }
    }

    private async touchHeartbeat(taskId: string) {
        await this.taskRepo.updateHeartbeat(taskId, new Date());
    }

    private async markSubmissionCompleted(taskId: string, errorCounts: Map<string, number>) {
        const task = await this.taskRepo.findByTaskId(taskId);
        if (!task) return;
        const pending = await this.bookingRepo.countPendingByTaskId(taskId);
        if (pending > 0) return; // 并发新增（不应发生），保守不推进

        if (task.status === BatchRefundTaskStatus.RUNNING) {
            task.status = BatchRefundTaskStatus.SUBMISSION_COMPLETED;
            task.submissionCompletedAt = new Date();
        }
        if (errorCounts.size > 0) {
            const summary = Array.from(errorCounts.entries())
                .map(([code, count]) => `${code}x${count}`)
                .join(', ');
            task.errorSummary = summary.substring(0, 500);
        }
        await this.taskRepo.save(task);
        this.logger.log(`批量退款任务提交完毕: ${taskId}, errorSummary=${task.errorSummary ?? '-'}`);

        // 提交完毕后立即尝试终态推进（全部 REFUNDED/FAILED 时直接 COMPLETED*）
        await this.recalcTaskStatus(task).catch(() => undefined);
    }

    /**
     * 任务状态重算（设计 2.6 推进规则；失败不影响订单退款状态）
     */
    async recalcTaskStatus(task: BatchRefundTask): Promise<BatchRefundTaskStatus> {
        const progress = await this.bookingRepo.aggregateBatchRefundProgress(task.taskId);

        let next: BatchRefundTaskStatus;
        if (progress.pending > 0) {
            next = BatchRefundTaskStatus.RUNNING;
        } else if (progress.processing > 0) {
            next = BatchRefundTaskStatus.SUBMISSION_COMPLETED;
        } else if (progress.failed > 0) {
            next = BatchRefundTaskStatus.COMPLETED_WITH_FAILURES;
        } else {
            next = BatchRefundTaskStatus.COMPLETED;
        }

        if (next !== task.status) {
            task.status = next;
        }
        if (next === BatchRefundTaskStatus.COMPLETED || next === BatchRefundTaskStatus.COMPLETED_WITH_FAILURES) {
            if (!task.completedAt) task.completedAt = new Date();
        }
        await this.taskRepo.save(task);
        return next;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Cron 兜底（每 10 分钟）
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * 1. 无活跃 worker 的 RUNNING 任务：重启 worker（应用意外退出/超预算中断后恢复）
     * 2. SUBMISSION_COMPLETED 任务：重算终态并补写 completedAt
     * 分钟错峰：避开整点/半点（xx:06/16/26/36/46/56）
     */
    @Cron('0 6,16,26,36,46,56 * * * *', { timeZone: 'Asia/Shanghai' })
    async runRecoverySweep() {
        try {
            const now = Date.now();
            // RUNNING 且心跳超时（或从未启动）
            const staleTasks = await this.taskRepo.findStaleRunningTasks(now - WORKER_STALE_MS);
            for (const task of staleTasks) {
                if (this.runningTaskId === task.taskId) continue; // 本进程 worker 活跃
                this.logger.warn(`批量退款 Cron 兜底恢复任务: ${task.taskId}`);
                this.startWorker(task.taskId);
            }

            // SUBMISSION_COMPLETED 兜底推进终态
            const recent = await this.taskRepo.findRecentTasks(50);
            for (const task of recent) {
                if (task.status === BatchRefundTaskStatus.SUBMISSION_COMPLETED) {
                    await this.recalcTaskStatus(task).catch(() => undefined);
                }
            }
        } catch (error) {
            this.logger.error('批量退款 Cron 兜底失败', error);
        }
    }
}
