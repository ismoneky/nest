import { Body, Controller, Delete, Get, HttpStatus, Param, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { BookingService } from './booking.service';
import { CreateBookingDto } from './dto/createBooking.dto';
import { GetBookingsDto } from './dto/getBookings.dto';
import { GetBookingStatsDto } from './dto/getBookingStats.dto';
import { UpdateBookingDto } from './dto/updateBooking.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

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
     * 删除预约订单
     * DELETE /bookings/:bookingId
     * @param bookingId 订单ID (UUID)
     * @param res Express 响应对象
     */
    @Delete(':bookingId')
    async deleteBooking(@Param('bookingId') bookingId: string, @Res() res: Response) {
        await this.bookingService.deleteBooking(bookingId);
        return res.status(HttpStatus.OK).send({
            success: true,
            message: 'Booking deleted successfully',
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
            return res.status(HttpStatus.BAD_REQUEST).send({
                success: false,
                message: 'Failed to initiate payment',
                error: error.message,
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
