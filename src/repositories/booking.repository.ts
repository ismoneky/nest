import { Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, Not, LessThan, Like } from 'typeorm';
import { Booking, BookingStatus, PaymentStatus, RefundStatus } from '../entities/booking.entity';
import { CreateBookingDto } from '../modules/booking/dto/createBooking.dto';
import { GetBookingsDto } from '../modules/booking/dto/getBookings.dto';
import { UpdateBookingDto } from '../modules/booking/dto/updateBooking.dto';
import { randomUUID } from 'crypto';

/**
 * 预约订单数据访问层
 */
@Injectable()
export class BookingRepository {
    constructor(
        @InjectRepository(Booking)
        private readonly bookingRepository: Repository<Booking>,
    ) {}

    /**
     * 创建预约订单
     * @param createBookingDto 创建订单数据传输对象
     * @returns 创建的订单实体
     */
    async createBooking(createBookingDto: any): Promise<Booking> {
        try {
            // 生成以 TL 开头的 11 位随机字符订单号
            const generateBookingId = () => `TL${randomUUID().replace(/-/g, '').substring(0, 11).toUpperCase()}`;

            const booking = this.bookingRepository.create({
                bookingId: generateBookingId(),
                ...createBookingDto,
                bookingDate: new Date(createBookingDto.bookingDate),
            });

            const savedBooking = await this.bookingRepository.save(booking);
            return Array.isArray(savedBooking) ? savedBooking[0] : savedBooking;
        } catch (error) {
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to create booking');
        }
    }

    /**
     * 更新预约订单
     * @param bookingId 订单ID
     * @param updateBookingDto 更新数据传输对象
     * @returns 更新后的订单实体
     */
    async updateBooking(bookingId: string, updateBookingDto: UpdateBookingDto): Promise<Booking> {
        try {
            const booking = await this.getBookingById(bookingId);

            // 如果更新日期,需要转换为 Date 对象
            if (updateBookingDto.bookingDate) {
                updateBookingDto.bookingDate = new Date(updateBookingDto.bookingDate) as any;
            }

            Object.assign(booking, updateBookingDto);
            return await this.bookingRepository.save(booking);
        } catch (error) {
            if (error instanceof NotFoundException) {
                throw error;
            }
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to update booking');
        }
    }

    /**
     * 删除预约订单
     * @param bookingId 订单ID
     * @returns 被删除的订单实体
     */
    async deleteBooking(bookingId: string): Promise<Booking> {
        try {
            const booking = await this.getBookingById(bookingId);
            return await this.bookingRepository.remove(booking);
        } catch (error) {
            if (error instanceof NotFoundException) {
                throw error;
            }
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to delete booking');
        }
    }

    /**
     * 根据订单ID查询单个订单
     * @param bookingId 订单ID
     * @returns 订单实体
     */
    async getBookingById(bookingId: string): Promise<Booking> {
        try {
            const booking = await this.bookingRepository.findOne({
                where: { bookingId },
            });

            if (!booking) {
                throw new NotFoundException(`Booking with ID ${bookingId} not found`);
            }

            return booking;
        } catch (error) {
            if (error instanceof NotFoundException) {
                throw error;
            }
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to get booking');
        }
    }

    /**
     * 根据条件查询订单列表 (分页)
     * 支持按 wechatOpenId, bookingDate, status 筛选
     * @param query 查询条件 (包含分页参数)
     * @returns 订单实体数组和总数
     */
    async getBookings(query: GetBookingsDto & { wechatOpenId?: string }) {
        try {
            const where: any = {};

            // 按微信OpenID筛选
            if (query.wechatOpenId) {
                where.wechatOpenId = query.wechatOpenId;
            }

            // 按预约日期筛选
            if (query.bookingDate) {
                const date = new Date(query.bookingDate);
                const nextDay = new Date(date);
                nextDay.setDate(date.getDate() + 1);
                where.bookingDate = Between(date, nextDay);
            }

            // 按订单状态筛选
            if (query.status) {
                where.status = query.status;
            }

            // 分页参数
            const page = query.page || 1;
            const pageSize = query.pageSize || 10;
            const skip = (page - 1) * pageSize;

            // 执行查询
            const [bookings, total] = await this.bookingRepository.findAndCount({
                where,
                order: { createdAt: 'DESC' },
                skip,
                take: pageSize,
            });

            return {
                bookings,
                total,
                page,
                pageSize,
                totalPages: Math.ceil(total / pageSize),
            };
        } catch (error) {
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to get bookings');
        }
    }

    /**
     * 统计当前用户各状态下的订单数量
     * @param wechatOpenId 用户 openid
     * @param status 可选，指定状态；不传则返回所有状态的数量
     * @returns 订单数量
     */
    async countBookingsByStatus(wechatOpenId: string, status?: BookingStatus): Promise<number> {
        const where: any = { wechatOpenId };
        if (status) {
            where.status = status;
        }
        return await this.bookingRepository.count({ where });
    }

    /**
     * 统计指定日期的预约人数 (按时间段分组)
     * @param bookingDate 预约日期 (YYYY-MM-DD)
     * @returns 各时间段的预约人数统计
     */
    async getBookingStatsByDate(bookingDate: string) {
        try {
            const date = new Date(bookingDate);
            const nextDay = new Date(date);
            nextDay.setDate(date.getDate() + 1);

            // 查询上午的统计
            const morningStats = await this.bookingRepository
                .createQueryBuilder('booking')
                .select('SUM(booking.personCount)', 'totalPeople')
                .addSelect('COUNT(*)', 'bookingCount')
                .where('booking.bookingDate >= :date', { date })
                .andWhere('booking.bookingDate < :nextDay', { nextDay })
                .andWhere('booking.timeSlot = :timeSlot', { timeSlot: 'morning' })
                .andWhere('booking.status IN (:...activeStatuses)', { activeStatuses: ['pending', 'confirmed'] })
                .getRawOne();

            // 查询下午的统计
            const afternoonStats = await this.bookingRepository
                .createQueryBuilder('booking')
                .select('SUM(booking.personCount)', 'totalPeople')
                .addSelect('COUNT(*)', 'bookingCount')
                .where('booking.bookingDate >= :date', { date })
                .andWhere('booking.bookingDate < :nextDay', { nextDay })
                .andWhere('booking.timeSlot = :timeSlot', { timeSlot: 'afternoon' })
                .andWhere('booking.status IN (:...activeStatuses)', { activeStatuses: ['pending', 'confirmed'] })
                .getRawOne();

            return {
                date: bookingDate,
                morning: {
                    totalPeople: parseInt(morningStats?.totalPeople || '0'),
                    bookingCount: parseInt(morningStats?.bookingCount || '0'),
                },
                afternoon: {
                    totalPeople: parseInt(afternoonStats?.totalPeople || '0'),
                    bookingCount: parseInt(afternoonStats?.bookingCount || '0'),
                },
            };
        } catch (error) {
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to get booking stats');
        }
    }

    /**
     * 管理员查询订单列表（无 openid 限制，支持关键字搜索）
     */
    async getBookingsForAdmin(query: {
        bookingDate?: string;
        status?: BookingStatus[];
        keyword?: string;
        page?: number;
        pageSize?: number;
    }) {
        try {
            const page = query.page || 1;
            const pageSize = query.pageSize || 10;
            const skip = (page - 1) * pageSize;

            const qb = this.bookingRepository
                .createQueryBuilder('booking')
                .orderBy('booking.createdAt', 'DESC')
                .skip(skip)
                .take(pageSize);

            if (query.bookingDate) {
                qb.andWhere('booking.bookingDate = :bookingDate', { bookingDate: query.bookingDate });
            }
            if (query.status?.length) {
                qb.andWhere('booking.status IN (:...status)', { status: query.status });
            }
            if (query.keyword) {
                qb.andWhere(
                    '(booking.name LIKE :kw OR booking.phone LIKE :kw OR booking.bookingId LIKE :kw)',
                    { kw: `%${query.keyword}%` },
                );
            }

            const [bookings, total] = await qb.getManyAndCount();

            return {
                bookings,
                total,
                page,
                pageSize,
                totalPages: Math.ceil(total / pageSize),
            };
        } catch (error) {
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to get bookings');
        }
    }

    /**
     * 获取全量订单（不分页，供导出使用）
     */
    async getAllBookingsForExport(query: {
        bookingDate?: string;
        status?: BookingStatus[];
        keyword?: string;
    }) {
        const qb = this.bookingRepository
            .createQueryBuilder('booking')
            .orderBy('booking.createdAt', 'DESC');

        if (query.bookingDate) {
            qb.andWhere('booking.bookingDate = :bookingDate', { bookingDate: query.bookingDate });
        }
        if (query.status?.length) {
            qb.andWhere('booking.status IN (:...status)', { status: query.status });
        }
        if (query.keyword) {
            qb.andWhere(
                '(booking.name LIKE :kw OR booking.phone LIKE :kw OR booking.bookingId LIKE :kw)',
                { kw: `%${query.keyword}%` },
            );
        }

        return qb.getMany();
    }

    /**
     * 更新过去日期的未完成订单为已完成状态
     */
    async updatePastBookings(todayStart: Date) {
        return await this.bookingRepository
            .createQueryBuilder()
            .update(Booking)
            .set({ status: BookingStatus.COMPLETED })
            .where('bookingDate < :todayStart', { todayStart })
            .andWhere('status = :status', { status: BookingStatus.CONFIRMED })
            .execute();
    }

    /**
     * 更新支付状态
     * @param bookingId 订单ID
     * @param paymentStatus 支付状态
     * @param outTradeNo 商户订单号
     * @param status 订单状态
     */
    async updatePaymentStatus(
        bookingId: string,
        paymentStatus: PaymentStatus,
        outTradeNo?: string,
        status?: BookingStatus
    ) {
        try {
            const booking = await this.getBookingById(bookingId);
            
            booking.paymentStatus = paymentStatus;
            if (outTradeNo) {
                booking.outTradeNo = outTradeNo;
            }
            if (status) {
                booking.status = status;
            }
            
            return await this.bookingRepository.save(booking);
        } catch (error) {
            if (error instanceof NotFoundException) {
                throw error;
            }
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to update payment status');
        }
    }

    /**
     * 根据商户订单号更新支付状态
     * @param outTradeNo 商户订单号
     * @param paymentStatus 支付状态
     * @param status 订单状态
     * @param transactionId 微信支付订单号
     * @param paidAt 支付时间
     */
    async updatePaymentStatusByOutTradeNo(
        outTradeNo: string,
        paymentStatus: PaymentStatus,
        status: BookingStatus,
        transactionId: string,
        paidAt: Date
    ) {
        try {
            return await this.bookingRepository
                .createQueryBuilder()
                .update(Booking)
                .set({
                    paymentStatus,
                    status,
                    transactionId,
                    paidAt,
                })
                .where('outTradeNo = :outTradeNo', { outTradeNo })
                .execute();
        } catch (error) {
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to update payment status by outTradeNo');
        }
    }

    /**
     * 更新退款状态
     * @param bookingId 订单ID
     * @param refundStatus 退款状态
     * @param outRefundNo 退款单号
     */
    async updateRefundStatus(
        bookingId: string,
        refundStatus: RefundStatus,
        outRefundNo?: string,
        paymentStatus?: PaymentStatus,
    ) {
        try {
            const booking = await this.getBookingById(bookingId);

            booking.refundStatus = refundStatus;
            if (outRefundNo) {
                booking.outRefundNo = outRefundNo;
            }
            if (paymentStatus) {
                booking.paymentStatus = paymentStatus;
            }

            if (refundStatus === RefundStatus.REFUNDING || refundStatus === RefundStatus.REFUNDED) {
                booking.status = BookingStatus.REFUNDED;
            }
            if (refundStatus === RefundStatus.REFUNDED) {
                booking.refundedAt = new Date();
            }

            return await this.bookingRepository.save(booking);
        } catch (error) {
            if (error instanceof NotFoundException) {
                throw error;
            }
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to update refund status');
        }
    }

    /**
     * 查询退款中的订单列表（用于定时对账）
     */
    async getRefundingOrders(): Promise<Booking[]> {
        try {
            return await this.bookingRepository.find({
                where: { refundStatus: RefundStatus.REFUNDING },
                select: ['bookingId', 'outRefundNo', 'outTradeNo', 'amount'],
            });
        } catch (error) {
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to get refunding orders');
        }
    }

    /**
     * 查询支付超时的订单列表（用于批量关单）
     * @param now 当前时间
     */
    async getPaymentTimeoutOrders(now: Date): Promise<Booking[]> {
        try {
            return await this.bookingRepository
                .createQueryBuilder('booking')
                .select(['booking.bookingId', 'booking.outTradeNo', 'booking.paymentStatus'])
                .where('booking.paymentExpiredAt < :now', { now: now.getTime() })
                .andWhere('booking.paymentStatus IN (:...statuses)', {
                    statuses: [PaymentStatus.UNPAID, PaymentStatus.PAYING],
                })
                .getMany();
        } catch (error) {
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to get payment timeout orders');
        }
    }

    /**
     * 更新支付超时订单
     * @param now 当前时间
     */
    async updatePaymentTimeoutOrders(now: Date) {
        try {
            return await this.bookingRepository
                .createQueryBuilder()
                .update(Booking)
                .set({
                    status: BookingStatus.CANCELLED,
                    paymentStatus: PaymentStatus.FAILED,
                })
                .where('paymentExpiredAt < :now', { now: now.getTime() })
                .andWhere('paymentStatus IN (:...statuses)', {
                    statuses: [PaymentStatus.UNPAID, PaymentStatus.PAYING]
                })
                .execute();
        } catch (error) {
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to update payment timeout orders');
        }
    }

    /**
     * 根据商户订单号查询订单
     * @param outTradeNo 商户订单号
     * @returns 订单实体
     */
    async getBookingByOutTradeNo(outTradeNo: string): Promise<Booking> {
        try {
            const booking = await this.bookingRepository.findOne({
                where: { outTradeNo },
            });

            if (!booking) {
                throw new NotFoundException(`Booking with outTradeNo ${outTradeNo} not found`);
            }

            return booking;
        } catch (error) {
            if (error instanceof NotFoundException) {
                throw error;
            }
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to get booking by outTradeNo');
        }
    }
}
