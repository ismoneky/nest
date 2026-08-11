import { Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not, LessThan, Like } from 'typeorm';
import { Booking, BookingStatus, PaymentStatus, RefundStatus } from '../entities/booking.entity';
import { BookingAnomaly, AnomalyType, AnomalyStatus } from '../entities/booking-anomaly.entity';
import { CreateBookingDto } from '../modules/booking/dto/createBooking.dto';
import { GetBookingsDto } from '../modules/booking/dto/getBookings.dto';
import { UpdateBookingDto } from '../modules/booking/dto/updateBooking.dto';
import { DataSource, EntityManager } from 'typeorm';
import { randomUUID } from 'crypto';

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
                paymentStatus: PaymentStatus.FAILED,
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
        return (await this.anomalyRepository
            .createQueryBuilder()
            .delete()
            .where('status IN (:...statuses)', { statuses: [AnomalyStatus.RESOLVED, AnomalyStatus.IGNORED] })
            .andWhere('resolvedAt IS NOT NULL')
            .andWhere('resolvedAt < :cutoff', { cutoff })
            .limit(limit)
            .execute()).affected ?? 0;
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
}
