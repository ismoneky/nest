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
import { IsEnum, IsOptional } from 'class-validator';

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
        return res.status(HttpStatus.OK).send({
            success: true,
            data: booking,
        });
    }

    /**
     * 更新预约订单
     * PUT /bookings/:bookingId
     * @param bookingId 订单ID (UUID)
     * @param updateBookingDto 更新数据
     * @param res Express 响应对象
     */
    @Put(':bookingId')
    async updateBooking(@Param('bookingId') bookingId: string, @Body() updateBookingDto: UpdateBookingDto, @Res() res: Response) {
        const booking = await this.bookingService.updateBooking(bookingId, updateBookingDto);
        return res.status(HttpStatus.OK).send({
            success: true,
            message: 'Booking updated successfully',
            data: booking,
        });
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
