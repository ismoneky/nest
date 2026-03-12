import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BookingRepository } from '../../repositories/booking.repository';
import { CreateBookingDto } from './dto/createBooking.dto';
import { GetBookingsDto } from './dto/getBookings.dto';
import { UpdateBookingDto } from './dto/updateBooking.dto';
import { TimeSlot, BookingStatus } from '../../entities/booking.entity';

/**
 * 预约订单业务逻辑层
 * 处理预约订单相关的业务逻辑
 */
@Injectable()
export class BookingService {
    private readonly logger = new Logger(BookingService.name);

    constructor(
        private readonly bookingRepository: BookingRepository,
    ) {}

    /**
     * 创建预约订单
     * @param createBookingDto 创建订单数据
     * @returns 创建的订单
     */
    async createBooking(createBookingDto: CreateBookingDto) {
        // 计算预约时间的具体时间点
        const bookingDate = new Date(createBookingDto.bookingDate);
        // 设置预约时间的完整日期和时间段
        const [year, month, day] = createBookingDto.bookingDate.split('-').map(Number);
        bookingDate.setFullYear(year, month - 1, day); // 设置预约日期

        if (createBookingDto.timeSlot === TimeSlot.MORNING) {
            bookingDate.setHours(12, 0, 0, 0); // 上午 12:00
        } else if (createBookingDto.timeSlot === TimeSlot.AFTERNOON) {
            bookingDate.setHours(18, 0, 0, 0); // 下午 18:00
        }

        // 计算延迟时间（预约时间 - 当前时间）
        const delay = bookingDate.getTime() - Date.now();
        if (delay <= 0) {
            throw new BadRequestException('预约时间必须晚于当前时间');
        }

        return await this.bookingRepository.createBooking(createBookingDto);
    }

    /**
     * 更新预约订单
     * @param bookingId 订单ID
     * @param updateBookingDto 更新数据
     * @returns 更新后的订单
     */
    async updateBooking(bookingId: string, updateBookingDto: UpdateBookingDto) {
        return await this.bookingRepository.updateBooking(bookingId, updateBookingDto);
    }

    /**
     * 删除预约订单
     * @param bookingId 订单ID
     * @returns 被删除的订单
     */
    async deleteBooking(bookingId: string) {
        return await this.bookingRepository.deleteBooking(bookingId);
    }

    /**
     * 根据订单ID查询订单
     * @param bookingId 订单ID
     * @returns 订单详情
     */
    async getBookingById(bookingId: string) {
        return await this.bookingRepository.getBookingById(bookingId);
    }

    /**
     * 查询订单列表 (分页)
     * @param query 查询条件 (包含分页参数)
     * @returns 订单列表和分页信息
     */
    async getBookings(query: GetBookingsDto) {
        return await this.bookingRepository.getBookings(query);
    }

    /**
     * 统计指定日期的预约人数
     * @param bookingDate 预约日期
     * @returns 各时间段的预约人数统计
     */
    async getBookingStatsByDate(bookingDate: string) {
        return await this.bookingRepository.getBookingStatsByDate(bookingDate);
    }

    /**
     * 定时处理过期订单
     * 每小时执行一次 (减轻服务器压力)
     */
    // @Cron(CronExpression.EVERY_MINUTE)
    @Cron(CronExpression.EVERY_HOUR)
    async handleCron() {
        this.logger.debug('Running booking cron job...');
        const now = new Date();
        // 确保构造的是 UTC 时间的 00:00:00，与 createBooking 时的 new Date(string) 保持一致
        const todayStart = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));

        // 1. 处理之前日期的未完成订单
        try {
            await this.bookingRepository.updateBookings(
                {
                    bookingDate: { $lt: todayStart },
                    status: { $nin: [BookingStatus.COMPLETED, BookingStatus.CANCELLED] },
                },
                { status: BookingStatus.COMPLETED }
            );
        } catch (error) {
            this.logger.error('Error updating past bookings', error);
        }

        // 2. 处理今天上午过期的订单 (12:00后)
        if (now.getHours() >= 12) {
            try {
                await this.bookingRepository.updateBookings(
                    {
                        bookingDate: todayStart,
                        timeSlot: TimeSlot.MORNING,
                        status: { $nin: [BookingStatus.COMPLETED, BookingStatus.CANCELLED] },
                    },
                    { status: BookingStatus.COMPLETED }
                );
            } catch (error) {
                this.logger.error('Error updating morning bookings', error);
            }
        }

        // 3. 处理今天下午过期的订单 (18:00后)
        if (now.getHours() >= 18) {
            try {
                await this.bookingRepository.updateBookings(
                    {
                        bookingDate: todayStart,
                        timeSlot: TimeSlot.AFTERNOON,
                        status: { $nin: [BookingStatus.COMPLETED, BookingStatus.CANCELLED] },
                    },
                    { status: BookingStatus.COMPLETED }
                );
            } catch (error) {
                this.logger.error('Error updating afternoon bookings', error);
            }
        }
    }
}
