import { Body, Controller, Delete, Get, HttpStatus, Param, Post, Put, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { BookingService } from './booking.service';
import { CreateBookingDto } from './dto/createBooking.dto';
import { GetBookingsDto } from './dto/getBookings.dto';
import { GetBookingStatsDto } from './dto/getBookingStats.dto';
import { UpdateBookingDto } from './dto/updateBooking.dto';

/**
 * 预约订单控制器
 * 处理预约订单相关的 HTTP 请求
 */
@Controller('bookings')
export class BookingController {
    constructor(private readonly bookingService: BookingService) {}

    /**
     * 创建预约订单
     * POST /bookings
     * @param createBookingDto 创建订单数据
     * @param res Express 响应对象
     */
    @Post()
    async createBooking(@Body() createBookingDto: CreateBookingDto, @Res() res: Response) {
        const booking = await this.bookingService.createBooking(createBookingDto);
        return res.status(HttpStatus.CREATED).send({
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
    async getBookings(@Query() query: GetBookingsDto, @Res() res: Response) {
        const result = await this.bookingService.getBookings(query);
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
     * 根据订单ID查询订单详情
     * GET /bookings/:bookingId
     * @param bookingId 订单ID (UUID)
     * @param res Express 响应对象
     */
    @Get(':bookingId')
    async getBookingById(@Param('bookingId') bookingId: string, @Res() res: Response) {
        const booking = await this.bookingService.getBookingById(bookingId);
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
}
