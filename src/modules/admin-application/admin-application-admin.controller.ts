import { Body, Controller, Get, HttpStatus, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { AdminAuthGuard } from '../../guards/admin-auth.guard';
import { AdminApplicationService } from './admin-application.service';
import { AdminApplicationStatus } from '../../entities/admin-application.entity';
import { RejectApplicationDto } from './dto/reject-application.dto';

@Controller('admin/applications')
export class AdminApplicationAdminController {
    constructor(private readonly adminApplicationService: AdminApplicationService) {}

    /**
     * 获取申请列表
     * GET /admin/applications?status=pending|approved|rejected
     */
    @Get()
    @UseGuards(AdminAuthGuard)
    async list(@Query('status') status: AdminApplicationStatus, @Res() res: Response) {
        const applications = await this.adminApplicationService.listApplications(status);
        return res.status(HttpStatus.OK).send({
            success: true,
            data: applications,
        });
    }

    /**
     * 审批通过
     * POST /admin/applications/:id/approve
     */
    @Post(':id/approve')
    @UseGuards(AdminAuthGuard)
    async approve(@Param('id') id: string, @Res() res: Response) {
        const application = await this.adminApplicationService.approveApplication(id);
        return res.status(HttpStatus.OK).send({
            success: true,
            message: '已批准',
            data: application,
        });
    }

    /**
     * 审批拒绝
     * POST /admin/applications/:id/reject
     */
    @Post(':id/reject')
    @UseGuards(AdminAuthGuard)
    async reject(@Param('id') id: string, @Body() dto: RejectApplicationDto, @Res() res: Response) {
        const application = await this.adminApplicationService.rejectApplication(id, dto.rejectionReason);
        return res.status(HttpStatus.OK).send({
            success: true,
            message: '已拒绝',
            data: application,
        });
    }
}
