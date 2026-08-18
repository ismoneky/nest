import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserModule } from '../user/user.module';
import { Feedback } from '../../entities/feedback.entity';
import { FeedbackRepository } from '../../repositories/feedback.repository';
import { FeedbackService } from './feedback.service';
import { FeedbackController } from './feedback.controller';

@Module({
    imports: [TypeOrmModule.forFeature([Feedback]), UserModule],
    controllers: [FeedbackController],
    providers: [FeedbackService, FeedbackRepository],
})
export class FeedbackModule {}
