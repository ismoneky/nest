import { Entity, Column, PrimaryGeneratedColumn, Index, BeforeInsert, BeforeUpdate } from 'typeorm';
import { timestampTransformer } from './timestamp.transformer';

/**
 * 批量退款任务状态（设计 2.3）
 */
export enum BatchRefundTaskStatus {
    RUNNING = 'RUNNING', // 仍有 PENDING 订单待提交
    SUBMISSION_COMPLETED = 'SUBMISSION_COMPLETED', // 提交完毕，等待回调/对账收敛
    COMPLETED = 'COMPLETED', // 全部目标 REFUNDED
    COMPLETED_WITH_FAILURES = 'COMPLETED_WITH_FAILURES', // 全部终态，存在 FAILED
}

/**
 * 批量退款任务
 * refundBatchTaskId 写在 bookings 上即目标快照，本表不保存订单 ID 数组。
 * 同一时刻最多一个 RUNNING 任务由唯一部分索引保证（生产手工 SQL 见 implementation-todo.md）。
 */
@Entity('batch_refund_tasks')
export class BatchRefundTask {
    @PrimaryGeneratedColumn()
    id: number;

    /** 唯一任务 ID */
    @Column({ unique: true })
    taskId: string;

    /** 选择摘要（所选订单去重预约日期逗号拼接，截断 100 字符；审计展示用，可空） */
    @Column({ type: 'varchar', nullable: true })
    selectionSummary?: string;

    /** 任务状态 */
    @Column({ type: 'varchar' })
    status: BatchRefundTaskStatus;

    /** 事务冻结成功的实际订单数 */
    @Column({ type: 'integer', default: 0 })
    totalTarget: number;

    /** 实际使用的退款原因 */
    @Column({ type: 'varchar' })
    reason: string;

    /** 执行管理员标识（管理端登录用户名） */
    @Column({ type: 'varchar' })
    operatorAdminId: string;

    /** 创建时间（毫秒 epoch） */
    @Column({ type: 'integer', transformer: timestampTransformer, default: () => `${Date.now()}` })
    createdAt: Date;

    /** 开始提交时间（毫秒 epoch） */
    @Column({ type: 'integer', nullable: true, transformer: timestampTransformer })
    startedAt?: Date;

    /** 提交完毕时间（毫秒 epoch） */
    @Column({ type: 'integer', nullable: true, transformer: timestampTransformer })
    submissionCompletedAt?: Date;

    /** 全部终态时间（毫秒 epoch） */
    @Column({ type: 'integer', nullable: true, transformer: timestampTransformer })
    completedAt?: Date;

    /** worker 心跳（毫秒 epoch，Cron 兜底判断依据） */
    @Column({ type: 'integer', nullable: true, transformer: timestampTransformer })
    lastHeartbeatAt?: Date;

    /** 批量提交过程中的错误摘要 */
    @Column({ type: 'varchar', nullable: true })
    errorSummary?: string;

    @BeforeInsert()
    setCreatedAt() {
        const now = new Date();
        if (!this.createdAt) this.createdAt = now;
        this.updatedAt = now;
    }

    @BeforeUpdate()
    setUpdatedAt() {
        this.updatedAt = new Date();
    }

    /** 更新时间（毫秒 epoch） */
    @Column({ type: 'integer', transformer: timestampTransformer, default: () => `${Date.now()}` })
    updatedAt: Date;
}
