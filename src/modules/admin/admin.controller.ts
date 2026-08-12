import { Body, Controller, Get, HttpStatus, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { AdminService } from './admin.service';
import { BookingService } from '../booking/booking.service';
import { LoginDto } from './dto/login.dto';
import { GetBookingsAdminDto } from './dto/get-bookings-admin.dto';
import { GetBookingDashboardDto } from './dto/get-booking-dashboard.dto';
import { AdminAuthGuard } from '../../common/guards/admin-jwt-auth.guard';

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
}
