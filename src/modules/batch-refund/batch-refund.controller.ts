import { Body, Controller, Get, HttpStatus, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { AdminAuthGuard } from '../../common/guards/admin-jwt-auth.guard';
import { BatchRefundService } from './batch-refund.service';
import { BatchRefundPreviewDto, ExecuteBatchRefundDto, ListBatchRefundTasksDto } from './dto/batch-refund.dto';

/**
 * 选择性批量退款管理端接口（设计 2.3）
 * 不提供暂停、继续，撤销或取消接口。
 */
@Controller('admin/batch-refund')
@UseGuards(AdminAuthGuard)
export class BatchRefundController {
    constructor(private readonly batchRefundService: BatchRefundService) {}

    /**
     * 预览：对勾选订单逐单分类 → 可退聚合 + 不可退分桶（附订单号）+ 掩码明细 + 当前 RUNNING 任务
     * POST /admin/batch-refund/preview（ID 列表在 body，不用 GET query）
     */
    @Post('preview')
    async preview(@Body() dto: BatchRefundPreviewDto, @Res() res: Response) {
        const data = await this.batchRefundService.preview(dto.bookingIds);
        return res.status(HttpStatus.OK).send({ success: true, data });
    }

    /**
     * 执行：事务创建任务并冻结订单，立即返回 taskId
     * POST /admin/batch-refund/execute
     * 409 已有 RUNNING 任务（返回 taskId）/ 400 无可退订单
     */
    @Post('execute')
    async execute(@Body() dto: ExecuteBatchRefundDto, @Res() res: Response) {
        // 管理端为 API Key 认证，无独立用户会话；operatorAdminId 记录请求来源标识
        const operatorAdminId = (res.req.headers['x-admin-user'] as string) || 'admin';
        const data = await this.batchRefundService.execute(dto.bookingIds, dto.reason, operatorAdminId);
        return res.status(HttpStatus.OK).send({ success: true, data });
    }

    /**
     * 历史任务列表（最近 N 条）
     * GET /admin/batch-refund/tasks
     */
    @Get('tasks')
    async listTasks(@Query() query: ListBatchRefundTasksDto, @Res() res: Response) {
        const data = await this.batchRefundService.listTasks(query.limit);
        return res.status(HttpStatus.OK).send({ success: true, data });
    }

    /**
     * 任务详情：元信息 + 实时聚合进度
     * GET /admin/batch-refund/tasks/:taskId
     */
    @Get('tasks/:taskId')
    async getTask(@Param('taskId') taskId: string, @Res() res: Response) {
        const data = await this.batchRefundService.getTask(taskId);
        return res.status(HttpStatus.OK).send({ success: true, data });
    }
}
