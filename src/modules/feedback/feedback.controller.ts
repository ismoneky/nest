import { Body, Controller, Get, HttpStatus, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { FeedbackService } from './feedback.service';
import { CreateFeedbackDto } from './dto/create-feedback.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AdminAuthGuard } from '../../guards/admin-auth.guard';

@Controller('feedbacks')
export class FeedbackController {
    constructor(private readonly feedbackService: FeedbackService) {}

    /**
     * 提交意见反馈
     * POST /feedbacks
     */
    @Post()
    @UseGuards(JwtAuthGuard)
    async createFeedback(@Body() dto: CreateFeedbackDto, @Req() req: Request, @Res() res: Response) {
        const { openid } = req['user'] as { openid: string };
        const feedback = await this.feedbackService.createFeedback(dto, openid);
        return res.status(HttpStatus.OK).send({
            success: true,
            message: '反馈提交成功',
            data: feedback,
        });
    }

    /**
     * 获取所有反馈（管理员）
     * GET /feedbacks
     */
    @Get()
    @UseGuards(AdminAuthGuard)
    async findAll(@Res() res: Response) {
        const feedbacks = await this.feedbackService.findAll();
        return res.status(HttpStatus.OK).send({
            success: true,
            data: feedbacks,
        });
    }
}
