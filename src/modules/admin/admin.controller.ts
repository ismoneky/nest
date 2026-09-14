import { Body, Controller, Get, HttpStatus, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { AdminService, AdminOperator } from './admin.service';
import { BookingService } from '../booking/booking.service';
import { LoginDto } from './dto/login.dto';
import { GetBookingsAdminDto } from './dto/get-bookings-admin.dto';
import { GetBookingDashboardDto } from './dto/get-booking-dashboard.dto';
import { AdminAuthGuard } from '../../common/guards/admin-jwt-auth.guard';
import { GetRefundAppliesAdminDto } from '../refund/dto/get-refund-applies-admin.dto';
import {
    ApproveRefundApplyDto,
    RejectRefundApplyDto,
} from '../refund/dto/audit-refund-apply.dto';
import { SendMessageDto } from './dto/send-message.dto';

@Controller('admin')
export class AdminController {
    constructor(
        private readonly adminService: AdminService,
        private readonly bookingService: BookingService,
    ) {}

    /**
     * 管理员登录
     * POST /admin/login
     */
    @Post('login')
    async login(@Body() loginDto: LoginDto, @Res() res: Response) {
        const result = await this.adminService.login(loginDto);
        return res.status(HttpStatus.OK).send({
            success: true,
            message: '登录成功',
            data: result,
        });
    }

    /**
     * 导出订单为 Excel（支持与列表相同的筛选条件）
     * GET /admin/bookings/export
     */
    @Get('bookings/export')
    @UseGuards(AdminAuthGuard)
    async exportBookings(@Query() query: GetBookingsAdminDto, @Res() res: Response) {
        const buffer = await this.adminService.exportBookingsToBuffer(query);
        const filename = `bookings_${new Date().toISOString().substring(0, 10)}.xlsx`;
        res.set({
            'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Content-Length': buffer.length,
        });
        res.end(buffer);
    }

    /**
     * 管理员查询订单列表
     * GET /admin/bookings
     */
    @Get('bookings')
    @UseGuards(AdminAuthGuard)
    async getBookings(@Query() query: GetBookingsAdminDto, @Res() res: Response) {
        const result = await this.bookingService.getBookingsForAdmin(query);
        return res.status(HttpStatus.OK).send({
            success: true,
            data: result.bookings,
            pagination: {
                page: result.page,
                pageSize: result.pageSize,
                total: result.total,
                totalPages: result.totalPages,
            },
        });
    }

    /**
     * 经营统计看板
     * GET /admin/bookings/dashboard?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
     * 所有统计以预约游玩日期 bookingDate 为筛选条件，起止日期均包含。
     */
    @Get('bookings/dashboard')
    @UseGuards(AdminAuthGuard)
    async getBookingDashboard(@Query() query: GetBookingDashboardDto, @Res() res: Response) {
        const data = await this.bookingService.getBookingDashboard(query.startDate, query.endDate);
        return res.status(HttpStatus.OK).send({
            success: true,
            data,
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 退款审核（阶段 3）
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * 退款申请列表
     * GET /admin/refund-applies?status=&createdStart=&createdEnd=&keyword=&page=&pageSize=
     */
    @Get('refund-applies')
    @UseGuards(AdminAuthGuard)
    async getRefundApplies(@Query() query: GetRefundAppliesAdminDto, @Res() res: Response) {
        const result = await this.adminService.getRefundApplies(query);
        return res.status(HttpStatus.OK).send({
            success: true,
            data: result.applies,
            pagination: {
                page: result.page,
                pageSize: result.pageSize,
                total: result.total,
                totalPages: result.totalPages,
            },
        });
    }

    /**
     * 退款申请详情（申请单 + 订单快照 + 该订单全部历史申请）
     * GET /admin/refund-applies/:applyNo
     */
    @Get('refund-applies/:applyNo')
    @UseGuards(AdminAuthGuard)
    async getRefundApplyDetail(@Param('applyNo') applyNo: string, @Res() res: Response) {
        const data = await this.adminService.getRefundApplyDetail(applyNo);
        return res.status(HttpStatus.OK).send({
            success: true,
            data,
        });
    }

    /**
     * 审核通过（真正发起退款）
     * POST /admin/refund-applies/:applyNo/approve
     *
     * 不 catch 异常：单据状态/并发冲突由全局过滤器透传成稳定错误码，
     * 包装会让管理端分不清「已被别人处理」和「退款发起失败」。
     */
    @Post('refund-applies/:applyNo/approve')
    @UseGuards(AdminAuthGuard)
    async approveRefundApply(
        @Param('applyNo') applyNo: string,
        @Body() dto: ApproveRefundApplyDto,
        @Req() req: Request,
        @Res() res: Response,
    ) {
        const result = await this.adminService.approveRefundApply(applyNo, extractOperator(req), dto.remark);
        return res.status(HttpStatus.OK).send({
            success: true,
            message: '审核通过，退款已发起',
            data: result,
        });
    }

    /**
     * 审核拒绝（不改订单状态）
     * POST /admin/refund-applies/:applyNo/reject
     */
    @Post('refund-applies/:applyNo/reject')
    @UseGuards(AdminAuthGuard)
    async rejectRefundApply(
        @Param('applyNo') applyNo: string,
        @Body() dto: RejectRefundApplyDto,
        @Req() req: Request,
        @Res() res: Response,
    ) {
        const apply = await this.adminService.rejectRefundApply(
            applyNo,
            extractOperator(req),
            dto.rejectReason,
            dto.remark,
        );
        return res.status(HttpStatus.OK).send({
            success: true,
            message: '已驳回该退款申请',
            data: apply,
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 站内信（阶段 4）
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * 手动发送站内信
     * POST /admin/messages/send
     *
     * 响应里带 `oaSent`（本期恒为 false）：服务号通道是独立分支，
     * 让管理端把「已发出」的提示建立在后端返回值上，而不是自己写死一句话——
     * 分支上线后前端不用改（§3.4）。
     */
    @Post('messages/send')
    @UseGuards(AdminAuthGuard)
    async sendMessage(@Body() dto: SendMessageDto, @Req() req: Request, @Res() res: Response) {
        const data = await this.adminService.sendMessage(dto, extractOperator(req));
        return res.status(HttpStatus.OK).send({
            success: true,
            message: '消息已发送',
            data,
        });
    }
}

/**
 * 从请求上取操作人身份（`AdminAuthGuard` 写入）
 *
 * 无 token 时守卫置 `req.admin = null`，这里归一成 `{ adminId: null, adminName: null }`。
 * 审核本身不因缺少操作人而失败——审计字段记 null 即可（§4.3.4）。
 */
function extractOperator(req: Request): AdminOperator {
    const admin = req['admin'] as { adminId: number; adminName: string } | null | undefined;
    return {
        adminId: admin?.adminId ?? null,
        adminName: admin?.adminName ?? null,
    };
}
