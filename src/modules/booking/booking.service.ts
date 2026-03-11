import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { BookingRepository } from '../../repositories/booking.repository';
import { CreateBookingDto } from './dto/createBooking.dto';
import { GetBookingsDto } from './dto/getBookings.dto';
import { UpdateBookingDto } from './dto/updateBooking.dto';
import { TimeSlot } from '../../entities/booking.entity';

/**
 * 预约订单业务逻辑层
 * 处理预约订单相关的业务逻辑
 */
@Injectable()
export class BookingService {
    constructor(
        private readonly bookingRepository: BookingRepository,
        @InjectQueue('booking') private readonly bookingQueue: Queue,
    ) {}

    /**
     * 创建预约订单
     * @param createBookingDto 创建订单数据
     * @returns 创建的订单
     */
    async createBooking(createBookingDto: CreateBookingDto) {
        const booking = await this.bookingRepository.createBooking(createBookingDto);

        // 计算预约时间的具体时间点
        const bookingDate = new Date(createBookingDto.bookingDate);
        // 设置预约时间的完整日期和时间段
        const [year, month, day] = createBookingDto.bookingDate.split('-').map(Number);
        bookingDate.setFullYear(year, month - 1, day); // 设置预约日期

        if (createBookingDto.timeSlot === TimeSlot.MORNING) {
            bookingDate.setHours(12, 0, 0, 0); // 上午 8:00
        } else if (createBookingDto.timeSlot === TimeSlot.AFTERNOON) {
            bookingDate.setHours(18, 0, 0, 0); // 下午 12:00
        }

        // 计算延迟时间（预约时间 - 当前时间）
        const delay = bookingDate.getTime() - Date.now();
        // if (delay > 0) {
        //     // 创建定时任务
        //     await this.bookingQueue.add('completeBooking', { bookingId: booking.bookingId }, { delay });
        // } else {
        //     throw new BadRequestException('预约时间必须晚于当前时间');
        // }

        return booking;
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
}
