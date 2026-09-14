import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BatchRefundTask, BatchRefundTaskStatus } from '../entities/batch-refund-task.entity';

/**
 * 批量退款任务数据访问层
 */
@Injectable()
export class BatchRefundTaskRepository {
    constructor(
        @InjectRepository(BatchRefundTask)
        private readonly taskRepository: Repository<BatchRefundTask>,
    ) {}

    async create(task: BatchRefundTask): Promise<BatchRefundTask> {
        return this.taskRepository.save(task);
    }

    async findByTaskId(taskId: string): Promise<BatchRefundTask | null> {
        return this.taskRepository.findOne({ where: { taskId } });
    }

    /** 当前 RUNNING 任务（最多一个，由唯一部分索引保证） */
    async findRunningTask(): Promise<BatchRefundTask | null> {
        return this.taskRepository.findOne({ where: { status: BatchRefundTaskStatus.RUNNING } });
    }

    /** 最近 N 条历史任务 */
    async findRecentTasks(limit = 20): Promise<BatchRefundTask[]> {
        return this.taskRepository.find({
            order: { id: 'DESC' },
            take: limit,
        });
    }

    /**
     * Cron 兜底：无活跃 worker 的 RUNNING 任务。
     * lastHeartbeatAt 为 NULL（创建后从未启动）不匹配 LessThan，由 service 单独兜底。
     */
    async findStaleRunningTasks(staleBefore: number): Promise<BatchRefundTask[]> {
        return this.taskRepository
            .createQueryBuilder('task')
            .where('task.status = :status', { status: BatchRefundTaskStatus.RUNNING })
            .andWhere('(task.lastHeartbeatAt IS NULL OR task.lastHeartbeatAt < :staleBefore)', { staleBefore })
            .orderBy('task.id', 'ASC')
            .getMany();
    }

    async save(task: BatchRefundTask): Promise<BatchRefundTask> {
        return this.taskRepository.save(task);
    }

    /** worker 心跳（条件更新，仅 RUNNING 任务） */
    async updateHeartbeat(taskId: string, at: Date): Promise<void> {
        await this.taskRepository.update(
            { taskId, status: BatchRefundTaskStatus.RUNNING },
            { lastHeartbeatAt: at } as any,
        );
    }
}
