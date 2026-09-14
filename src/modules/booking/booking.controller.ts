import { Body, Controller, Get, HttpStatus, Param, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { BookingService } from './booking.service';
import { CreateBookingDto } from './dto/createBooking.dto';
import { PreviewBookingDto } from './dto/previewBooking.dto';
import { GetBookingsDto } from './dto/getBookings.dto';
import { GetBookingStatsDto } from './dto/getBookingStats.dto';
import { UpdateBookingDto } from './dto/updateBooking.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { BookingStatus } from '../../entities/booking.entity';
import { PaymentException } from '../../common/payment-errors';
import { BookingException } from '../../common/booking-errors';
import { IsEnum, IsOptional } from 'class-validator';
import { RefundApplyService } from '../refund/refund-apply.service';
import { SubmitRefundApplyDto } from '../refund/dto/submit-refund-apply.dto';

class GetBookingCountDto {
    @IsOptional()
    @IsEnum(BookingStatus)
    status?: BookingStatus;
}

/**
 * 预约订单控制器
 * 处理预约订单相关的 HTTP 请求
 */
@Controller('bookings')
export class BookingController {
    constructor(
        private readonly bookingService: BookingService,
        private readonly refundApplyService: RefundApplyService,
    ) {}

    /**
     * 创建预约订单
     * POST /bookings
     * @param createBookingDto 创建订单数据
     * @param res Express 响应对象
     */
    @Post()
    @UseGuards(JwtAuthGuard)
    async createBooking(@Body() createBookingDto: CreateBookingDto, @Req() req: Request, @Res() res: Response) {
        const { openid } = req['user'] as { openid: string };
        const booking = await this.bookingService.createBooking({ ...createBookingDto, wechatOpenId: openid });
        return res.status(HttpStatus.OK).send({
            success: true,
            message: 'Booking created successfully',
            data: booking,
        });
    }

    /**
     * 预约费用预览（后端为唯一事实来源，前端进入预约页 / 修改乘客 / 修改日期时调用）
     * POST /bookings/preview
     * 注意：此路由必须声明在 :bookingId 参数路由之前，避免被参数路由吃掉
     * @param dto 预览入参（出行人员 + 预约日期）
     * @returns 完整费用与免费判定预览（不写库、不抢锁）
     */
    @Post('preview')
    @UseGuards(JwtAuthGuard)
    async previewBooking(@Body() dto: PreviewBookingDto, @Req() req: Request, @Res() res: Response) {
        const { openid } = req['user'] as { openid: string };
        const result = await this.bookingService.determineFreeEligibility(
            openid,
            dto.passengers,
            dto.bookingDate,
            dto.travelMode,
            dto.vehicleType,
            dto.licensePlate,
        );
        return res.status(HttpStatus.OK).send({
            success: true,
            data: result,
        });
    }

    /**
     * 查询订单列表 (分页)
     * GET /bookings?page=1&pageSize=10&wechatOpenId=xxx&bookingDate=2024-03-15&timeSlot=morning&status=pending
     * @param query 查询条件 (包含分页参数)
     * @param res Express 响应对象
     */
    @Get()
    @UseGuards(JwtAuthGuard)
    async getBookings(@Query() query: GetBookingsDto, @Req() req: Request, @Res() res: Response) {
        const { openid } = req['user'] as { openid: string };
        const result = await this.bookingService.getBookings({ ...query, wechatOpenId: openid });
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
     * 统计指定日期的预约人数
     * GET /bookings/stats/by-date?bookingDate=2024-03-15
     * @param query 查询条件 (包含预约日期)
     * @param res Express 响应对象
     */
    @Get('stats/by-date')
    async getBookingStatsByDate(@Query() query: GetBookingStatsDto, @Res() res: Response) {
        const stats = await this.bookingService.getBookingStatsByDate(query.bookingDate);
        return res.status(HttpStatus.OK).send({
            success: true,
            data: stats,
        });
    }

    /**
     * 今日名额概览（提交订单页展示「今日名额 + 剩余免费名额」，前端 90 秒轮询）
     * GET /bookings/today-quota
     *
     * 匿名可访问，无 @UseGuards（与 stats/by-date 同族的产品决策）。
     *
     * 【安全约束，改前必读】本接口的存在意义是不泄漏每日营收，因此：
     *  1. 签名里刻意【不声明 @Query()】—— 不接受任何日期参数，服务端固定用
     *     beijingDateStr() 取「今天」。这样全局 ValidationPipe 的 whitelist 根本不参与，
     *     请求带 ?bookingDate=2020-01-01 会被直接忽略，约束由类型系统而非纪律保证。
     *     目的是防止被批量回捞历史序列、反推每日总量。
     *  2. 只返回剩余，【绝不返回】total / maxPeople / currentPeople / bookingCount ——
     *     单价公开，故 已约人数 × 单价 ≈ 每日营收；而「已约人数 = 总限额 − 剩余」，
     *     返回总限额等于把已约人数直接送出去。
     *  3. 本路由是单段静态路径，必须声明在 @Get(':bookingId') 之前，否则会被参数路由吃掉。
     *
     * 字段级约束详见 dto/today-quota.dto.ts 顶部说明。
     */
    @Get('today-quota')
    async getTodayQuota(@Res() res: Response) {
        const data = await this.bookingService.getTodayQuotaOverview();
        return res.status(HttpStatus.OK).send({
            success: true,
            data,
        });
    }

    /**
     * 查询当前用户指定状态下的订单数量
     * GET /bookings/count?status=pending
     * @param query 查询条件，status 可选
     * @param req Express 请求对象
     * @param res Express 响应对象
     */
    @Get('count')
    @UseGuards(JwtAuthGuard)
    async getBookingCount(@Query() query: GetBookingCountDto, @Req() req: Request, @Res() res: Response) {
        const { openid } = req['user'] as { openid: string };
        const count = await this.bookingService.countBookingsByStatus(openid, query.status);
        return res.status(HttpStatus.OK).send({
            success: true,
            data: { count },
        });
    }

    /**
     * 根据订单ID查询订单详情
     * GET /bookings/:bookingId
     * @param bookingId 订单ID (UUID)
     * @param res Express 响应对象
     */
    @Get(':bookingId')
    @UseGuards(JwtAuthGuard)
    async getBookingById(@Param('bookingId') bookingId: string, @Req() req: Request, @Res() res: Response) {
        const { openid } = req['user'] as { openid: string };
        const booking = await this.bookingService.getBookingById(bookingId, openid);
        // 退款入口显隐由后端下发（§4.3.5）：前端只读 refundEntry.visible，
        // 时限、次数、进行中申请的判定全部在服务端，规则改动零前端发版。
        const refundEntry = await this.refundApplyService.buildRefundEntry(booking);
        // 小程序端**不下发核销人**：用户只需要知道「几点核销的」，
        // 核销员姓名（`verifiedByName`）是给后台追责用的，对游客没有意义。
        // 也就不在这里调 attachVerifierNames —— 省掉一次查库，
        // 详情接口是会被轮询的热点路径。
        return res.status(HttpStatus.OK).send({
            success: true,
            data: { ...booking, refundEntry },
        });
    }

    /**
     * 提交退款申请（过期订单的资金出口，§4.3.1）
     * POST /bookings/:bookingId/refund-apply
     *
     * 与 `POST /bookings/:bookingId/refund`（自助退款，仅 confirmed 单）是两条路：
     * 过期订单必须先申请、经管理员审核，通过后由服务端带 asAdmin 走同一套退款链路。
     *
     * 这里**不 catch 异常**：`RefundException` 自带稳定 errorCode，
     * 由全局过滤器透传成 `{ success: false, code, message }`；自己包装会把错误码丢掉。
     *
     * @param dto 退款原因（必填）
     */
    @Post(':bookingId/refund-apply')
    @UseGuards(JwtAuthGuard)
    async submitRefundApply(
        @Param('bookingId') bookingId: string,
        @Body() dto: SubmitRefundApplyDto,
        @Req() req: Request,
        @Res() res: Response,
    ) {
        const { openid } = req['user'] as { openid: string };
        // getBookingById 会做归属校验（不属于该用户直接 400），订单不存在也在此拦下
        const booking = await this.bookingService.getBookingById(bookingId, openid);
        const apply = await this.refundApplyService.submitApply(booking, openid, dto.reason);
        return res.status(HttpStatus.OK).send({
            success: true,
            message: '退款申请已提交，请等待审核',
            data: apply,
        });
    }

    /**
     * 取消预约订单（推荐入口）
     * POST /bookings/:bookingId/cancel
     * @param bookingId 订单ID (UUID)
     * @param req Express 请求对象
     * @param res Express 响应对象
     */
    @Post(':bookingId/cancel')
    @UseGuards(JwtAuthGuard)
    async cancelBooking(@Param('bookingId') bookingId: string, @Req() req: Request, @Res() res: Response) {
        const { openid } = req['user'] as { openid: string };
        try {
            const booking = await this.bookingService.cancelBooking(bookingId, openid);
            return res.status(HttpStatus.OK).send({
                success: true,
                message: '预约已取消',
                data: booking,
            });
        } catch (error) {
            // 与 /pay 同一套稳定错误码契约：结构不变，另附 errorCode 供前端按码分支
            const errorCode = error instanceof BookingException ? error.code : undefined;
            return res.status(HttpStatus.BAD_REQUEST).send({
                success: false,
                message: '取消预约失败',
                error: error.message,
                ...(errorCode ? { errorCode } : {}),
            });
        }
    }

    /**
     * 更新预约订单 —— **已废弃，仅为兼容未更新的小程序版本保留取消语义**
     *
     * 旧实现没有 @UseGuards、没有归属校验，且 UpdateBookingDto 允许任意 status 与业务字段，
     * 任何人拿到订单号即可改写他人订单（含伪造核销码）。见 dto/updateBooking.dto.ts 的说明。
     * 现在：加 Guard + 归属校验，且只有 `status: 'cancelled'` 会被受理，其余一律 400。
     *
     * @deprecated 改用 `POST /bookings/:bookingId/cancel`；小程序全量更新后删除本端点
     */
    @Put(':bookingId')
    @UseGuards(JwtAuthGuard)
    async updateBooking(
        @Param('bookingId') bookingId: string,
        @Body() updateBookingDto: UpdateBookingDto,
        @Req() req: Request,
        @Res() res: Response,
    ) {
        const { openid } = req['user'] as { openid: string };

        // 兜底判定：DTO 的 @IsOptional 允许 status 缺失，@IsIn 只在校验管道生效时拦非 cancelled 取值，
        // 所以这里必须自己判一次 —— 缺 status 与传错值都走同一个 400。
        if (updateBookingDto.status !== 'cancelled') {
            return res.status(HttpStatus.BAD_REQUEST).send({
                success: false,
                message: '该接口已废弃，仅支持取消订单',
                error: '请使用 POST /bookings/:bookingId/cancel',
            });
        }

        try {
            const booking = await this.bookingService.cancelBooking(bookingId, openid);
            return res.status(HttpStatus.OK).send({
                success: true,
                message: '预约已取消',
                data: booking,
            });
        } catch (error) {
            const errorCode = error instanceof BookingException ? error.code : undefined;
            return res.status(HttpStatus.BAD_REQUEST).send({
                success: false,
                message: '取消预约失败',
                error: error.message,
                ...(errorCode ? { errorCode } : {}),
            });
        }
    }

    /**
     * 发起支付
     * POST /bookings/:bookingId/pay
     * @param bookingId 订单ID (UUID)
     * @param res Express 响应对象
     */
    @Post(':bookingId/pay')
    @UseGuards(JwtAuthGuard)
    async payBooking(@Param('bookingId') bookingId: string, @Req() req: Request, @Res() res: Response) {
        try {
            const { openid } = req['user'] as { openid: string };
            const paymentParams = await this.bookingService.initiatePayment(bookingId, openid);
            return res.status(HttpStatus.OK).send({
                success: true,
                message: 'Payment initiated successfully',
                data: paymentParams,
            });
        } catch (error) {
            // 稳定错误码契约（待设计确认，见 implementation-todo.md 待确认问题 6）：
            // 保持现有响应结构不变，附 errorCode 字段供前端按码分支（已支付/超时/结果未知等）
            const errorCode = error instanceof PaymentException ? error.code : undefined;
            return res.status(HttpStatus.BAD_REQUEST).send({
                success: false,
                message: 'Failed to initiate payment',
                error: error.message,
                ...(errorCode ? { errorCode } : {}),
            });
        }
    }

    /**
     * 查询支付状态
     * GET /bookings/:bookingId/pay-status
     * @param bookingId 订单ID (UUID)
     * @param res Express 响应对象
     */
    @Get(':bookingId/pay-status')
    async getPaymentStatus(@Param('bookingId') bookingId: string, @Res() res: Response) {
        try {
            const status = await this.bookingService.getPaymentStatus(bookingId);
            return res.status(HttpStatus.OK).send({
                success: true,
                data: status,
            });
        } catch (error) {
            return res.status(HttpStatus.BAD_REQUEST).send({
                success: false,
                message: 'Failed to get payment status',
                error: error.message,
            });
        }
    }

    /**
     * 核验订单（管理员扫码）
     * POST /bookings/:bookingId/verify
     * @param bookingId 订单ID
     * @param res Express 响应对象
     */
    @Post(':bookingId/verify')
    @UseGuards(JwtAuthGuard)
    async verifyBooking(@Param('bookingId') bookingId: string, @Req() req: Request, @Res() res: Response) {
        const { openid } = req['user'] as { openid: string };
        const booking = await this.bookingService.verifyBooking(bookingId, openid);
        return res.status(HttpStatus.OK).send({
            success: true,
            message: '核验成功',
            data: booking,
        });
    }

    /**
     * 申请退款
     * POST /bookings/:bookingId/refund
     * @param bookingId 订单ID (UUID)
     * @param res Express 响应对象
     */
    @Post(':bookingId/refund')
    @UseGuards(JwtAuthGuard)
    async refundBooking(@Param('bookingId') bookingId: string, @Req() req: Request, @Res() res: Response) {
        try {
            const { openid } = req['user'] as { openid: string };
            const refundResult = await this.bookingService.initiateRefund(bookingId, openid);
            return res.status(HttpStatus.OK).send({
                success: true,
                message: 'Refund initiated successfully',
                data: refundResult,
            });
        } catch (error) {
            return res.status(HttpStatus.BAD_REQUEST).send({
                success: false,
                message: 'Failed to initiate refund',
                error: error.message,
            });
        }
    }
}
