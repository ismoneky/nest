import { Injectable } from '@nestjs/common';
import { FeedbackRepository } from '../../repositories/feedback.repository';
import { CreateFeedbackDto } from './dto/create-feedback.dto';

@Injectable()
export class FeedbackService {
    constructor(private readonly feedbackRepository: FeedbackRepository) {}

    async createFeedback(dto: CreateFeedbackDto, wechatOpenId: string) {
        return this.feedbackRepository.createFeedback(wechatOpenId, dto.phone, dto.content);
    }

    async findAll() {
        return this.feedbackRepository.findAll();
    }
}
