import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { Feedback } from '../entities/feedback.entity';
import { serialSave } from '../common/transaction-runner';

@Injectable()
export class FeedbackRepository {
    constructor(
        @InjectRepository(Feedback)
        private readonly repo: Repository<Feedback>,
    ) {}

    async createFeedback(wechatOpenId: string, phone: string, content: string): Promise<Feedback> {
        const feedback = this.repo.create({
            feedbackId: randomUUID(),
            wechatOpenId,
            phone,
            content,
        });
        return serialSave(this.repo, feedback);
    }

    /**
     * 全部反馈，**最新的在前**（后台「反馈统计」第一页要看的就是最近的）
     *
     * 次级键 `id DESC` 不是装饰：`createdAt` 只到毫秒，同一毫秒插入的两条
     * 谁前谁后由 SQLite 自己定，刷新一次可能就换了个位置。
     * `id` 是自增主键，与插入顺序同向，拿它兜底能得到一个**稳定**的倒序。
     */
    async findAll(): Promise<Feedback[]> {
        return this.repo.find({ order: { createdAt: 'DESC', id: 'DESC' } });
    }
}
