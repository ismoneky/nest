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

    async findAll(): Promise<Feedback[]> {
        return this.repo.find({ order: { createdAt: 'DESC' } });
    }
}
