import { Body, Controller, HttpStatus, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AdminApplicationService } from './admin-application.service';
import { ApplyDto } from './dto/apply.dto';

@Controller('admin-application')
export class AdminApplicationController {
    constructor(private readonly adminApplicationService: AdminApplicationService) {}

    /**
     * 用户申请成为管理员
     * POST /admin-application/apply
     */
    @Post('apply')
    @UseGuards(JwtAuthGuard)
    async apply(@Body() dto: ApplyDto, @Req() req: Request, @Res() res: Response) {
        const { openid } = req['user'] as { openid: string };
        const application = await this.adminApplicationService.apply(openid, dto.phone, dto.name);
        return res.status(HttpStatus.OK).send({
            success: true,
            message: '申请已提交，等待审核',
            data: application,
        });
    }
}
