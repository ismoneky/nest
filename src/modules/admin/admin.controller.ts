import {
    Body,
    Controller,
    Get,
    HttpStatus,
    InternalServerErrorException,
    Param,
    Post,
    Query,
    Req,
    Res,
    UseGuards,
} from '@nestjs/common';
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
import { TriggerTaskDto } from './dto/trigger-task.dto';

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

    // ─────────────────────────────────────────────────────────────────────────
    // 定时任务手动触发（测试 / 运维）
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * 手动执行 T1 过期扫描
     * POST /admin/tasks/expire-scan
     *
     * ── 为什么有这个接口 ───────────────────────────────────────────────────
     * 扫描任务原本只能靠 cron 等到点（T1 每小时 :13、T2 每天 22:00），
     * 测试环境里没法「立刻跑一次，看它到底扫到了什么」。这里只是把同一个方法调一次，
     * 不改动任何扫描逻辑，也不绕过静默期与去重。
     *
     * ⚠️ **有真实副作用**：把 `bookingDate < 今天` 且未核销的订单置为 expired，
     * 并给这些订单的用户发站内信。单轮上限 `MESSAGE_SCAN_BATCH_LIMIT`（200）条，
     * 积压多时要连续调用几轮才能消化完。
     *
     * 可传 `quietWindowMinutes` 覆盖本次的静默期（默认 2 小时，0 = 不设），见 `TriggerTaskDto`。
     */
    @Post('tasks/expire-scan')
    @UseGuards(AdminAuthGuard)
    async triggerExpireScan(@Body() dto: TriggerTaskDto, @Res() res: Response) {
        const data = await this.bookingService.runExpireScan({
            quietWindowMs: toQuietWindowMs(dto),
        });
        if (data.error) throw new InternalServerErrorException(data.error);
        return res.status(HttpStatus.OK).send({
            success: true,
            message: data.skipped
                ? '上一轮尚未结束，本次未执行'
                : `扫描完成：转入过期 ${data.expiredCount} 单，发出通知 ${data.notifiedCount} 条（静默期 ${data.quietWindowMinutes} 分钟）`,
            data,
        });
    }

    /**
     * 手动执行 T2 每日提醒
     * POST /admin/tasks/daily-reminder
     *
     * ⚠️ 这个任务**设计上跑在每天 22:00**：① 号分支发给「今天已预约但还没核销」的用户，
     * 文案是「今天快结束了，请尽快核销」。白天或凌晨手动触发，同样会给这批人发出去——
     * 内容不算错，但换到这个时点就是打扰。测试可以，别当成日常运维手段。
     */
    @Post('tasks/daily-reminder')
    @UseGuards(AdminAuthGuard)
    async triggerDailyReminder(@Body() dto: TriggerTaskDto, @Res() res: Response) {
        const data = await this.bookingService.runDailyReminderScan({
            quietWindowMs: toQuietWindowMs(dto),
        });
        if (data.error) throw new InternalServerErrorException(data.error);
        return res.status(HttpStatus.OK).send({
            success: true,
            message: data.skipped
                ? '上一轮尚未结束，本次未执行'
                : `提醒完成：核销提醒 ${data.remindedCount} 条，过期可退款提醒 ${data.recalledCount} 条（静默期 ${data.quietWindowMinutes} 分钟）`,
            data,
        });
    }
}

/**
 * 分钟 → 毫秒；未传返回 `undefined`，由 service 落到 A 规则的默认 2 小时
 *
 * 转换放在这一层而不是 service：service 只认毫秒（它与 cron 共用），
 * 「分钟」是给 HTTP 调用方看的单位。
 */
function toQuietWindowMs(dto: TriggerTaskDto): number | undefined {
    return dto.quietWindowMinutes === undefined ? undefined : dto.quietWindowMinutes * 60 * 1000;
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
