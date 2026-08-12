import { Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not, LessThan, Like } from 'typeorm';
import { Booking, BookingStatus, PaymentStatus, RefundStatus, TravelMode } from '../entities/booking.entity';
import { BookingAnomaly, AnomalyType, AnomalyStatus } from '../entities/booking-anomaly.entity';
import { CreateBookingDto } from '../modules/booking/dto/createBooking.dto';
import { GetBookingsDto } from '../modules/booking/dto/getBookings.dto';
import { UpdateBookingDto } from '../modules/booking/dto/updateBooking.dto';
import { DataSource, EntityManager } from 'typeorm';
import { randomUUID } from 'crypto';
import { BookingDashboardResponse } from '../modules/admin/interfaces/booking-dashboard.interface';

/**
 * 对账任务类型
 */
export type ReconcileKind = 'payment' | 'refund' | 'close';

/**
 * 预约订单数据访问层
 *
 * 转换协议原则：Repository 只提供带期望状态条件的原子更新（返回 affected rows），
 * 不决定业务转换；转换决策由 BookingService 的命名动作完成。
 */
@Injectable()
export class BookingRepository {
    constructor(
        @InjectRepository(Booking)
        private readonly bookingRepository: Repository<Booking>,
        @InjectRepository(BookingAnomaly)
        private readonly anomalyRepository: Repository<BookingAnomaly>,
        private readonly dataSource: DataSource,
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
            // SQLite date 列存储为纯日期字符串，不能用 new Date() 构造 Date 对象比较
            if (query.bookingDate) {
                where.bookingDate = query.bookingDate.length >= 10
                    ? query.bookingDate.substring(0, 10)
                    : query.bookingDate;
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
            // SQLite 的 date 列存储为纯日期字符串 "YYYY-MM-DD"，
            // 不能用 new Date() 构造 Date 对象传入比较（会变成 ISO 字符串带时间部分，
            // 导致字符串比较时 "2026-04-26" < "2026-04-26T00:00:00.000Z"，当天记录被排除）
            // 直接用纯日期字符串做 >= 和 <= 比较
            const dateStr = bookingDate.length >= 10 ? bookingDate.substring(0, 10) : bookingDate;

            // 查询上午的统计
            const morningStats = await this.bookingRepository
                .createQueryBuilder('booking')
                .select('SUM(booking.personCount)', 'totalPeople')
                .addSelect('COUNT(*)', 'bookingCount')
                .where('booking.bookingDate >= :date', { date: dateStr })
                .andWhere('booking.bookingDate <= :nextDate', { nextDate: dateStr })
                .andWhere('booking.timeSlot = :timeSlot', { timeSlot: 'morning' })
                .andWhere('booking.status IN (:...activeStatuses)', { activeStatuses: ['pending', 'confirmed'] })
                .getRawOne();

            // 查询下午的统计
            const afternoonStats = await this.bookingRepository
                .createQueryBuilder('booking')
                .select('SUM(booking.personCount)', 'totalPeople')
                .addSelect('COUNT(*)', 'bookingCount')
                .where('booking.bookingDate >= :date', { date: dateStr })
                .andWhere('booking.bookingDate <= :nextDate', { nextDate: dateStr })
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
        createdStart?: string;
        createdEnd?: string;
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
                // createdAt + id 双排序，保证同毫秒订单顺序稳定，分页不重复/不丢行
                .orderBy('booking.createdAt', 'DESC')
                .addOrderBy('booking.id', 'DESC')
                .skip(skip)
                .take(pageSize);

            if (query.bookingDate) {
                qb.andWhere('booking.bookingDate = :bookingDate', { bookingDate: query.bookingDate });
            }
            // createdAt 存的是毫秒时间戳，createdStart 当天 00:00:00、createdEnd 当天 23:59:59.999
            if (query.createdStart) {
                const start = new Date(query.createdStart);
                start.setHours(0, 0, 0, 0);
                qb.andWhere('booking.createdAt >= :createdStart', { createdStart: start.getTime() });
            }
            if (query.createdEnd) {
                const end = new Date(query.createdEnd);
                end.setHours(23, 59, 59, 999);
                qb.andWhere('booking.createdAt <= :createdEnd', { createdEnd: end.getTime() });
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
        createdStart?: string;
        createdEnd?: string;
        status?: BookingStatus[];
        keyword?: string;
    }) {
        const qb = this.bookingRepository
            .createQueryBuilder('booking')
            .orderBy('booking.createdAt', 'DESC')
            .addOrderBy('booking.id', 'DESC');

        if (query.bookingDate) {
            qb.andWhere('booking.bookingDate = :bookingDate', { bookingDate: query.bookingDate });
        }
        if (query.createdStart) {
            const start = new Date(query.createdStart);
            start.setHours(0, 0, 0, 0);
            qb.andWhere('booking.createdAt >= :createdStart', { createdStart: start.getTime() });
        }
        if (query.createdEnd) {
            const end = new Date(query.createdEnd);
            end.setHours(23, 59, 59, 999);
            qb.andWhere('booking.createdAt <= :createdEnd', { createdEnd: end.getTime() });
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

    // ─────────────────────────────────────────────────────────────────────────
    // 对账候选查询
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * 统一精准候选查询：按 reconcileKind + reconcileNextAt 取到期候选。
     * 不使用绝对时间窗口，服务停机数日后未解决订单仍能进入对账。
     * 业务状态条件与转换协议表一致：
     *   payment：PAYING 且未过期
     *   refund：REFUNDING
     *   close：UNPAID/PAYING 且已过期
     */
    async findReconcileCandidates(kind: ReconcileKind, now: number, limit = 20): Promise<Booking[]> {
        const qb = this.bookingRepository
            .createQueryBuilder('booking')
            .select([
                'booking.bookingId',
                'booking.outTradeNo',
                'booking.outRefundNo',
                'booking.status',
                'booking.paymentStatus',
                'booking.refundStatus',
                'booking.paymentExpiredAt',
                'booking.reconcileAttempts',
                'booking.reconcileLastErrorCode',
                'booking.amount',
            ])
            .where('booking.reconcileKind = :kind', { kind })
            .andWhere('booking.reconcileNextAt <= :now', { now })
            .orderBy('booking.reconcileNextAt', 'ASC')
            .addOrderBy('booking.id', 'ASC')
            .take(limit);

        if (kind === 'payment') {
            qb.andWhere('booking.paymentStatus = :ps', { ps: PaymentStatus.PAYING });
            qb.andWhere('booking.paymentExpiredAt >= :now', { now });
        } else if (kind === 'refund') {
            qb.andWhere('booking.refundStatus = :rs', { rs: RefundStatus.REFUNDING });
        } else {
            qb.andWhere('booking.paymentStatus IN (:...statuses)', {
                statuses: [PaymentStatus.UNPAID, PaymentStatus.PAYING],
            });
            qb.andWhere('booking.paymentExpiredAt < :now', { now });
        }

        return qb.getMany();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 支付转换协议条件更新（全部返回 affected rows，0 表示订单已被其他流程推进）
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * markPaymentStarting：PENDING + UNPAID/PAYING 且未过期、旧 outTradeNo 与步骤 7 读取值一致
     * （首次为 NULL，被拒后带号换单时为保留的旧号）→ PAYING + 新 outTradeNo + payment 调度字段，attempts 清零
     */
    async markPaymentStarting(bookingId: string, oldOutTradeNo: string | null, newOutTradeNo: string, nextAt: number, now: number): Promise<number> {
        const qb = this.bookingRepository
            .createQueryBuilder()
            .update(Booking)
            .set({
                paymentStatus: PaymentStatus.PAYING,
                outTradeNo: newOutTradeNo,
                reconcileKind: 'payment',
                reconcileNextAt: nextAt,
                reconcileAttempts: 0,
                reconcileLastErrorCode: null,
            })
            .where('bookingId = :bookingId', { bookingId })
            .andWhere('status = :status', { status: BookingStatus.PENDING })
            .andWhere('paymentStatus IN (:...statuses)', { statuses: [PaymentStatus.UNPAID, PaymentStatus.PAYING] })
            .andWhere('paymentExpiredAt >= :now', { now });

        if (oldOutTradeNo) {
            qb.andWhere('outTradeNo = :old', { old: oldOutTradeNo });
        } else {
            qb.andWhere('outTradeNo IS NULL');
        }

        return (await qb.execute()).affected ?? 0;
    }

    /**
     * markPaymentStartRejected：微信明确拒绝且未建单 → UNPAID，保留 outTradeNo，
     * 清空 payment 调度字段，保留稳定错误码
     */
    async markPaymentStartRejected(bookingId: string, outTradeNo: string, errorCode: string): Promise<number> {
        return (await this.bookingRepository
            .createQueryBuilder()
            .update(Booking)
            .set({
                paymentStatus: PaymentStatus.UNPAID,
                reconcileKind: null,
                reconcileNextAt: null,
                reconcileAttempts: 0,
                reconcileLastErrorCode: errorCode,
            })
            .where('bookingId = :bookingId', { bookingId })
            .andWhere('paymentStatus = :ps', { ps: PaymentStatus.PAYING })
            .andWhere('outTradeNo = :outTradeNo', { outTradeNo })
            .execute()).affected ?? 0;
    }

    /**
     * markPaymentResultUnknown：微信请求结果未知 → 保持 PAYING，
     * reconcileKind=payment、reconcileNextAt=now、attempts 加一，记录稳定错误码
     */
    async markPaymentResultUnknown(bookingId: string, outTradeNo: string, errorCode: string, now: number): Promise<number> {
        return (await this.bookingRepository
            .createQueryBuilder()
            .update(Booking)
            .set({
                reconcileKind: 'payment',
                reconcileNextAt: now,
                reconcileLastAt: now,
                reconcileAttempts: () => '"reconcileAttempts" + 1',
                reconcileLastErrorCode: errorCode,
            })
            .where('bookingId = :bookingId', { bookingId })
            .andWhere('paymentStatus = :ps', { ps: PaymentStatus.PAYING })
            .andWhere('outTradeNo = :outTradeNo', { outTradeNo })
            .execute()).affected ?? 0;
    }

    /**
     * reschedulePaymentCheck：支付对账仍未支付 → 保持业务状态，设置下一次执行时间，清空本次临时错误
     */
    async reschedulePaymentCheck(bookingId: string, outTradeNo: string, nextAt: number, now: number): Promise<number> {
        return (await this.bookingRepository
            .createQueryBuilder()
            .update(Booking)
            .set({
                reconcileKind: 'payment',
                reconcileNextAt: nextAt,
                reconcileLastAt: now,
                reconcileLastErrorCode: null,
            })
            .where('bookingId = :bookingId', { bookingId })
            .andWhere('paymentStatus = :ps', { ps: PaymentStatus.PAYING })
            .andWhere('outTradeNo = :outTradeNo', { outTradeNo })
            .execute()).affected ?? 0;
    }

    /**
     * markPaymentSucceeded：支付成功回调/对账（最高优先级确认）。
     * 非支付终态且 outTradeNo 相同 → CONFIRMED + PAID，写 transactionId/paidAt，清空全部调度字段
     */
    async markPaymentSucceeded(outTradeNo: string, transactionId: string | null, paidAt: Date): Promise<number> {
        return (await this.bookingRepository
            .createQueryBuilder()
            .update(Booking)
            .set({
                paymentStatus: PaymentStatus.PAID,
                status: BookingStatus.CONFIRMED,
                transactionId: transactionId ?? undefined,
                paidAt,
                reconcileKind: null,
                reconcileNextAt: null,
                reconcileAttempts: 0,
                reconcileLastAt: null,
                reconcileLastErrorCode: null,
            })
            .where('outTradeNo = :outTradeNo', { outTradeNo })
            .andWhere('paymentStatus NOT IN (:...excluded)', {
                excluded: [PaymentStatus.PAID, PaymentStatus.REFUNDING, PaymentStatus.REFUNDED],
            })
            .execute()).affected ?? 0;
    }

    /**
     * markPaymentFailed：支付对账明确终态失败 → 按微信终态设为 FAILED/CANCELLED，清空调度字段
     */
    async markPaymentFailed(bookingId: string, outTradeNo: string, paymentStatus: PaymentStatus, bookingStatus: BookingStatus): Promise<number> {
        return (await this.bookingRepository
            .createQueryBuilder()
            .update(Booking)
            .set({
                paymentStatus,
                status: bookingStatus,
                reconcileKind: null,
                reconcileNextAt: null,
                reconcileAttempts: 0,
                reconcileLastErrorCode: null,
            })
            .where('bookingId = :bookingId', { bookingId })
            .andWhere('paymentStatus = :ps', { ps: PaymentStatus.PAYING })
            .andWhere('outTradeNo = :outTradeNo', { outTradeNo })
            .execute()).affected ?? 0;
    }

    /**
     * markCloseDue：支付到期待关单 → 保持业务状态，reconcileKind=close、reconcileNextAt=now。
     * 发现步骤：扫描所有已过期的 UNPAID/PAYING 订单（含从未发起支付、无调度字段的订单）。
     */
    async markCloseDue(now: number): Promise<number> {
        return (await this.bookingRepository
            .createQueryBuilder()
            .update(Booking)
            .set({
                reconcileKind: 'close',
                reconcileNextAt: now,
            })
            .where('paymentExpiredAt < :now', { now })
            .andWhere('paymentStatus IN (:...statuses)', {
                statuses: [PaymentStatus.UNPAID, PaymentStatus.PAYING],
            })
            .execute()).affected ?? 0;
    }

    /**
     * markPaymentClosed：超时关单只更新本批已明确处理且当前状态仍符合条件的订单。
     * processedBookingIds 只包含微信明确关单成功、明确已关闭或业务规则确认无需关单的订单。
     */
    async markPaymentClosed(bookingIds: string[], now: number): Promise<number> {
        if (bookingIds.length === 0) return 0;
        return (await this.bookingRepository
            .createQueryBuilder()
            .update(Booking)
            .set({
                status: BookingStatus.CANCELLED,
                paymentStatus: PaymentStatus.FAILED,
                reconcileKind: null,
                reconcileNextAt: null,
            })
            .where('bookingId IN (:...ids)', { ids: bookingIds })
            .andWhere('paymentStatus IN (:...statuses)', {
                statuses: [PaymentStatus.UNPAID, PaymentStatus.PAYING],
            })
            .andWhere('paymentExpiredAt < :now', { now })
            .execute()).affected ?? 0;
    }

    /**
     * markCloseResultUnknown：关单结果未知（网络超时/解析失败）→ 保持业务状态，
     * reconcileKind=close、reconcileNextAt 重排到下一关单轮、attempts 加一、记录稳定错误码。
     * 与 markPaymentResultUnknown 对称的关单临时失败计数（设计表格未列，见 implementation-todo.md）。
     */
    async markCloseResultUnknown(bookingId: string, errorCode: string, nextAt: number, now: number): Promise<number> {
        return (await this.bookingRepository
            .createQueryBuilder()
            .update(Booking)
            .set({
                reconcileKind: 'close',
                reconcileNextAt: nextAt,
                reconcileLastAt: now,
                reconcileAttempts: () => '"reconcileAttempts" + 1',
                reconcileLastErrorCode: errorCode,
            })
            .where('bookingId = :bookingId', { bookingId })
            .andWhere('paymentStatus IN (:...statuses)', {
                statuses: [PaymentStatus.UNPAID, PaymentStatus.PAYING],
            })
            .execute()).affected ?? 0;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 退款转换协议条件更新
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * markRefundStarting：CONFIRMED + PAID + refund NONE/FAILED → REFUNDING，
     * 写 outRefundNo，reconcileKind=refund、reconcileNextAt=now+15min，attempts 清零。
     * 保持 status=confirmed、paymentStatus=paid（状态变化留待退款终态）。
     */
    async markRefundStarting(bookingId: string, outRefundNo: string, nextAt: number): Promise<number> {
        return (await this.bookingRepository
            .createQueryBuilder()
            .update(Booking)
            .set({
                refundStatus: RefundStatus.REFUNDING,
                outRefundNo,
                reconcileKind: 'refund',
                reconcileNextAt: nextAt,
                reconcileAttempts: 0,
                reconcileLastErrorCode: null,
            })
            .where('bookingId = :bookingId', { bookingId })
            .andWhere('status = :status', { status: BookingStatus.CONFIRMED })
            .andWhere('paymentStatus = :ps', { ps: PaymentStatus.PAID })
            .andWhere('refundStatus IN (:...statuses)', {
                statuses: [RefundStatus.NONE, RefundStatus.FAILED],
            })
            .execute()).affected ?? 0;
    }

    /**
     * markRefundSucceeded：退款回调或对账成功 → 退款成功终态，写 refundedAt，清空调度字段
     */
    async markRefundSucceeded(bookingId: string, outRefundNo: string, refundedAt: Date): Promise<number> {
        return (await this.bookingRepository
            .createQueryBuilder()
            .update(Booking)
            .set({
                refundStatus: RefundStatus.REFUNDED,
                paymentStatus: PaymentStatus.REFUNDED,
                status: BookingStatus.REFUNDED,
                refundedAt,
                reconcileKind: null,
                reconcileNextAt: null,
                reconcileAttempts: 0,
                reconcileLastErrorCode: null,
            })
            .where('bookingId = :bookingId', { bookingId })
            .andWhere('refundStatus = :rs', { rs: RefundStatus.REFUNDING })
            .andWhere('outRefundNo = :outRefundNo', { outRefundNo })
            .execute()).affected ?? 0;
    }

    /**
     * markRefundFailed：微信明确退款失败（ABNORMAL/CLOSED）→ 本地退款失败终态，清空调度字段。
     * 设计转换协议表未列该动作，为退款明确终态失败的必要分支（见 implementation-todo.md 实现说明）。
     */
    async markRefundFailed(bookingId: string, outRefundNo: string): Promise<number> {
        return (await this.bookingRepository
            .createQueryBuilder()
            .update(Booking)
            .set({
                refundStatus: RefundStatus.FAILED,
                // paymentStatus 保持 PAID：支付仍有效，仅退款失败，允许用户重试
                // （initiateRefund 要求 paymentStatus=PAID；markRefundStarting 允许 refundStatus=FAILED 重入）
                reconcileKind: null,
                reconcileNextAt: null,
                reconcileAttempts: 0,
                reconcileLastErrorCode: null,
            })
            .where('bookingId = :bookingId', { bookingId })
            .andWhere('refundStatus = :rs', { rs: RefundStatus.REFUNDING })
            .andWhere('outRefundNo = :outRefundNo', { outRefundNo })
            .execute()).affected ?? 0;
    }

    /**
     * markRefundResultUnknown：退款请求结果未知 → 保持 REFUNDING，
     * reconcileKind=refund、reconcileNextAt=now、attempts 加一，记录稳定错误码。
     * 设计表格未列该动作，为与 markPaymentResultUnknown 对称的退款临时失败分支（见 implementation-todo.md 实现说明）。
     */
    async markRefundResultUnknown(bookingId: string, outRefundNo: string, errorCode: string, now: number): Promise<number> {
        return (await this.bookingRepository
            .createQueryBuilder()
            .update(Booking)
            .set({
                reconcileKind: 'refund',
                reconcileNextAt: now,
                reconcileLastAt: now,
                reconcileAttempts: () => '"reconcileAttempts" + 1',
                reconcileLastErrorCode: errorCode,
            })
            .where('bookingId = :bookingId', { bookingId })
            .andWhere('refundStatus = :rs', { rs: RefundStatus.REFUNDING })
            .andWhere('outRefundNo = :outRefundNo', { outRefundNo })
            .execute()).affected ?? 0;
    }

    /**
     * rescheduleRefundCheck：退款仍处理中 → 保持业务状态，设置下一次执行时间，清空本次临时错误
     */
    async rescheduleRefundCheck(bookingId: string, outRefundNo: string, nextAt: number, now: number): Promise<number> {
        return (await this.bookingRepository
            .createQueryBuilder()
            .update(Booking)
            .set({
                reconcileKind: 'refund',
                reconcileNextAt: nextAt,
                reconcileLastAt: now,
                reconcileLastErrorCode: null,
            })
            .where('bookingId = :bookingId', { bookingId })
            .andWhere('refundStatus = :rs', { rs: RefundStatus.REFUNDING })
            .andWhere('outRefundNo = :outRefundNo', { outRefundNo })
            .execute()).affected ?? 0;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 异常订单
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * upsertAnomaly：同一 bookingId + type 只保留一条记录。
     * 相同异常再次出现：增加 occurrenceCount、更新 lastSeenAt、重新打开（清空 resolvedAt/resolution）。
     */
    async upsertAnomaly(
        bookingId: string,
        type: AnomalyType,
        errorCode: string | null,
        summary: string | null,
        nextRetryAt: number | null,
        now: number,
        em?: EntityManager,
    ): Promise<void> {
        const runner = em ?? this.dataSource;
        await runner.query(
            `INSERT INTO booking_anomalies
                (bookingId, type, status, firstSeenAt, lastSeenAt, occurrenceCount, lastErrorCode, lastErrorSummary, nextRetryAt)
             VALUES (?, ?, 'OPEN', ?, ?, 1, ?, ?, ?)
             ON CONFLICT(bookingId, type) DO UPDATE SET
                status = 'OPEN',
                lastSeenAt = excluded.lastSeenAt,
                occurrenceCount = booking_anomalies.occurrenceCount + 1,
                lastErrorCode = excluded.lastErrorCode,
                lastErrorSummary = excluded.lastErrorSummary,
                nextRetryAt = excluded.nextRetryAt,
                resolvedAt = NULL,
                resolution = NULL`,
            [bookingId, type, now, now, errorCode, summary, nextRetryAt],
        );
    }

    /**
     * escalateReconciliationAnomaly：达到异常阈值 → 同一事务内 upsert anomaly 并清空订单正常通道调度字段。
     */
    async escalateReconciliationAnomaly(
        bookingId: string,
        type: AnomalyType,
        errorCode: string | null,
        summary: string | null,
        nextRetryAt: number | null,
    ): Promise<void> {
        const now = Date.now();
        await this.dataSource.transaction(async (em) => {
            await this.upsertAnomaly(bookingId, type, errorCode, summary, nextRetryAt, now, em);
            await em
                .createQueryBuilder()
                .update(Booking)
                .set({ reconcileKind: null, reconcileNextAt: null })
                .where('bookingId = :bookingId', { bookingId })
                .execute();
        });
    }

    /**
     * 清理已解决/忽略的异常记录：resolvedAt 后保留 365 天。
     * 没有 resolvedAt 的非 OPEN 记录视为数据异常并保留，不能按 lastSeenAt 猜测删除。
     */
    async deleteResolvedAnomalies(cutoff: number, limit = 100): Promise<number> {
        // SQLite 不支持 DELETE ... LIMIT，用子查询限定每批条数，保证短事务。
        // sqlite3 驱动的 .query() 对 DELETE 返回空数组（无 affected/changes），必须用事务
        // 固定同一连接，DELETE 后立即 SELECT changes() 取删除行数。
        return this.dataSource.transaction(async (em) => {
            await em.query(
                `DELETE FROM booking_anomalies WHERE id IN (
                    SELECT id FROM booking_anomalies
                    WHERE status IN ('RESOLVED', 'IGNORED')
                      AND resolvedAt IS NOT NULL
                      AND resolvedAt < ?
                    ORDER BY id ASC LIMIT ?
                )`,
                [cutoff, limit],
            );
            const rows: any[] = await em.query(`SELECT changes() AS count`);
            return rows[0]?.count ?? 0;
        });
    }

    /**
     * 异常任务候选查询：OPEN 且 nextRetryAt 已到期。
     * nextRetryAt 为 NULL（人工暂停）不匹配 <= 条件，自动排除。
     */
    async findOpenAnomalies(now: number, limit = 5): Promise<BookingAnomaly[]> {
        return this.anomalyRepository
            .createQueryBuilder('anomaly')
            .where('anomaly.status = :status', { status: AnomalyStatus.OPEN })
            .andWhere('anomaly.nextRetryAt <= :now', { now })
            .orderBy('anomaly.nextRetryAt', 'ASC')
            .addOrderBy('anomaly.id', 'ASC')
            .take(limit)
            .getMany();
    }

    /**
     * 异常通道重试后仍不确定：按退避时间更新 nextRetryAt（不作为"再次发生"，不累加 occurrenceCount）
     */
    async rescheduleAnomalyRetry(bookingId: string, type: AnomalyType, nextRetryAt: number): Promise<number> {
        return (await this.anomalyRepository
            .createQueryBuilder()
            .update(BookingAnomaly)
            .set({ nextRetryAt })
            .where('bookingId = :bookingId', { bookingId })
            .andWhere('type = :type', { type })
            .andWhere('status = :status', { status: AnomalyStatus.OPEN })
            .execute()).affected ?? 0;
    }

    /**
     * 对账成功后自动标记 RESOLVED（只处理 OPEN，不覆盖人工 IGNORED）
     */
    async resolveAnomaly(bookingId: string, type: AnomalyType, resolution: string, now: number): Promise<number> {
        return (await this.anomalyRepository
            .createQueryBuilder()
            .update(BookingAnomaly)
            .set({
                status: AnomalyStatus.RESOLVED,
                resolvedAt: now,
                resolution,
            })
            .where('bookingId = :bookingId', { bookingId })
            .andWhere('type = :type', { type })
            .andWhere('status = :status', { status: AnomalyStatus.OPEN })
            .execute()).affected ?? 0;
    }

    /**
     * 经营统计聚合（按预约游玩日期 bookingDate 筛选）
     *
     * 口径（与设计 1.3 一致）：
     * - 有效预约状态：confirmed、completed
     * - 实收金额：paymentStatus=paid 且状态为 confirmed/completed 的 amount 之和
     * - 自驾车辆数：有效订单中 travelMode=selfDriving 且 licensePlate 非空，一单一车
     * - 状态分布：范围内全部订单按五种状态计数
     * - 出行方式分布：仅统计有效订单
     * - dailyTrend：按 bookingDate 分组，无数据日期补 0，保证连续
     *
     * SQLite bookingDate 为纯日期字符串，直接用 >= / <= 比较，不转 Date。
     */
    async getBookingDashboard(startDate: string, endDate: string): Promise<BookingDashboardResponse> {
        try {
            // 截取为 YYYY-MM-DD，纯字符串比较
            const start = startDate.length >= 10 ? startDate.substring(0, 10) : startDate;
            const end = endDate.length >= 10 ? endDate.substring(0, 10) : endDate;

            const validStatuses: BookingStatus[] = [BookingStatus.CONFIRMED, BookingStatus.COMPLETED];
            const allStatuses: BookingStatus[] = [
                BookingStatus.PENDING,
                BookingStatus.CONFIRMED,
                BookingStatus.COMPLETED,
                BookingStatus.CANCELLED,
                BookingStatus.REFUNDED,
            ];
            const allTravelModes: TravelMode[] = [TravelMode.SCENIC_BUS, TravelMode.SELF_DRIVING, TravelMode.TOUR_GROUP];

            // 1) summary：有效订单数 / 总人数 / 自驾车辆数 / 实收金额 / 免费&收费人数
            const summaryRow = await this.bookingRepository
                .createQueryBuilder('booking')
                .select('COUNT(*)', 'validOrderCount')
                .addSelect('SUM(booking.personCount)', 'totalPeople')
                .addSelect("SUM(CASE WHEN booking.travelMode = :selfDriving AND booking.licensePlate IS NOT NULL AND booking.licensePlate != '' THEN 1 ELSE 0 END)", 'selfDrivingVehicleCount')
                .addSelect("SUM(CASE WHEN booking.paymentStatus = :paid THEN COALESCE(booking.amount, 0) ELSE 0 END)", 'receivedAmount')
                .addSelect("SUM(CASE WHEN booking.isFree = 1 THEN booking.personCount ELSE 0 END)", 'freePeople')
                .addSelect("SUM(CASE WHEN booking.isFree = 0 THEN booking.personCount ELSE 0 END)", 'paidPeople')
                .where('booking.bookingDate >= :start', { start })
                .andWhere('booking.bookingDate <= :end', { end })
                .andWhere('booking.status IN (:...validStatuses)', { validStatuses })
                .setParameter('selfDriving', TravelMode.SELF_DRIVING)
                .setParameter('paid', PaymentStatus.PAID)
                .getRawOne();

            // 2) statusDistribution：范围内全部订单按状态计数（不排除任何状态）
            const statusRows = await this.bookingRepository
                .createQueryBuilder('booking')
                .select('booking.status', 'status')
                .addSelect('COUNT(*)', 'orderCount')
                .where('booking.bookingDate >= :start', { start })
                .andWhere('booking.bookingDate <= :end', { end })
                .groupBy('booking.status')
                .getRawMany<{ status: BookingStatus; orderCount: string | number }>();

            const statusMap = new Map<BookingStatus, number>();
            for (const row of statusRows) {
                statusMap.set(row.status, toNumber(row.orderCount));
            }
            const statusDistribution = allStatuses.map((s) => ({
                status: s,
                orderCount: statusMap.get(s) ?? 0,
            }));

            // 3) travelModeDistribution：仅统计有效订单，返回订单数与人数
            const travelModeRows = await this.bookingRepository
                .createQueryBuilder('booking')
                .select('booking.travelMode', 'travelMode')
                .addSelect('COUNT(*)', 'orderCount')
                .addSelect('SUM(booking.personCount)', 'peopleCount')
                .where('booking.bookingDate >= :start', { start })
                .andWhere('booking.bookingDate <= :end', { end })
                .andWhere('booking.status IN (:...validStatuses)', { validStatuses })
                .groupBy('booking.travelMode')
                .getRawMany<{ travelMode: TravelMode; orderCount: string | number; peopleCount: string | number }>();

            const travelModeMap = new Map<TravelMode, { orderCount: number; peopleCount: number }>();
            for (const row of travelModeRows) {
                travelModeMap.set(row.travelMode, {
                    orderCount: toNumber(row.orderCount),
                    peopleCount: toNumber(row.peopleCount),
                });
            }
            const travelModeDistribution = allTravelModes.map((m) => ({
                travelMode: m,
                orderCount: travelModeMap.get(m)?.orderCount ?? 0,
                peopleCount: travelModeMap.get(m)?.peopleCount ?? 0,
            }));

            // 4) dailyTrend：按 bookingDate 分组的有效订单聚合，再补齐无数据日期
            const dailyRows = await this.bookingRepository
                .createQueryBuilder('booking')
                .select('booking.bookingDate', 'date')
                .addSelect('COUNT(*)', 'validOrderCount')
                .addSelect('SUM(booking.personCount)', 'peopleCount')
                .addSelect("SUM(CASE WHEN booking.travelMode = :selfDriving AND booking.licensePlate IS NOT NULL AND booking.licensePlate != '' THEN 1 ELSE 0 END)", 'selfDrivingVehicleCount')
                .addSelect("SUM(CASE WHEN booking.paymentStatus = :paid THEN COALESCE(booking.amount, 0) ELSE 0 END)", 'receivedAmount')
                .where('booking.bookingDate >= :start', { start })
                .andWhere('booking.bookingDate <= :end', { end })
                .andWhere('booking.status IN (:...validStatuses)', { validStatuses })
                .setParameter('selfDriving', TravelMode.SELF_DRIVING)
                .setParameter('paid', PaymentStatus.PAID)
                .groupBy('booking.bookingDate')
                .orderBy('booking.bookingDate', 'ASC')
                .getRawMany<{
                    date: string;
                    validOrderCount: string | number;
                    peopleCount: string | number;
                    selfDrivingVehicleCount: string | number;
                    receivedAmount: string | number;
                }>();

            const dailyMap = new Map<string, { validOrderCount: number; peopleCount: number; selfDrivingVehicleCount: number; receivedAmount: number }>();
            for (const row of dailyRows) {
                // SQLite date 列读出可能是 'YYYY-MM-DD' 或 Date 对象，统一截取前 10 位
                const dateStr = String(row.date).substring(0, 10);
                dailyMap.set(dateStr, {
                    validOrderCount: toNumber(row.validOrderCount),
                    peopleCount: toNumber(row.peopleCount),
                    selfDrivingVehicleCount: toNumber(row.selfDrivingVehicleCount),
                    receivedAmount: toNumber(row.receivedAmount),
                });
            }

            const dailyTrend = fillDateRange(start, end).map((dateStr) => ({
                date: dateStr,
                validOrderCount: dailyMap.get(dateStr)?.validOrderCount ?? 0,
                peopleCount: dailyMap.get(dateStr)?.peopleCount ?? 0,
                selfDrivingVehicleCount: dailyMap.get(dateStr)?.selfDrivingVehicleCount ?? 0,
                receivedAmount: dailyMap.get(dateStr)?.receivedAmount ?? 0,
            }));

            return {
                range: { startDate: start, endDate: end },
                summary: {
                    validOrderCount: toNumber(summaryRow?.validOrderCount),
                    totalPeople: toNumber(summaryRow?.totalPeople),
                    selfDrivingVehicleCount: toNumber(summaryRow?.selfDrivingVehicleCount),
                    receivedAmount: toNumber(summaryRow?.receivedAmount),
                    freePeople: toNumber(summaryRow?.freePeople),
                    paidPeople: toNumber(summaryRow?.paidPeople),
                },
                statusDistribution,
                travelModeDistribution,
                dailyTrend,
            };
        } catch (error) {
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to get booking dashboard');
        }
    }
}

/**
 * 安全转 number：SQLite 聚合结果可能是字符串或 null，统一转有限 number，null/NaN 返回 0
 */
function toNumber(value: unknown): number {
    if (value == null || value === '') return 0;
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

/**
 * 生成 [start, end] 内的连续自然日（YYYY-MM-DD），纯日期迭代，升序
 */
function fillDateRange(start: string, end: string): string[] {
    const result: string[] = [];
    // 解析 YYYY-MM-DD，避免 Date 时区偏移
    const [sy, sm, sd] = start.split('-').map(Number);
    const [ey, em, ed] = end.split('-').map(Number);
    let current = new Date(sy, sm - 1, sd);
    const last = new Date(ey, em - 1, ed);
    // 安全上限，避免异常输入导致死循环
    let guard = 0;
    while (current <= last && guard < 1000) {
        const y = current.getFullYear();
        const m = String(current.getMonth() + 1).padStart(2, '0');
        const d = String(current.getDate()).padStart(2, '0');
        result.push(`${y}-${m}-${d}`);
        current.setDate(current.getDate() + 1);
        guard++;
    }
    return result;
}
