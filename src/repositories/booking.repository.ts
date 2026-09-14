import { Injectable, BadRequestException, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not, LessThan, Like } from 'typeorm';
import { Booking, BookingStatus, PaymentStatus, RefundStatus, RefundSource, RefundSubmitStatus, TravelMode } from '../entities/booking.entity';
import { BookingAnomaly, AnomalyType, AnomalyStatus } from '../entities/booking-anomaly.entity';
import { CreateBookingDto } from '../modules/booking/dto/createBooking.dto';
import { GetBookingsDto } from '../modules/booking/dto/getBookings.dto';
import { UpdateBookingDto } from '../modules/booking/dto/updateBooking.dto';
import { DataSource, EntityManager } from 'typeorm';
import { randomUUID } from 'crypto';
import { BookingDashboardResponse } from '../modules/admin/interfaces/booking-dashboard.interface';
import { classifyAdminRefundEligibility, applyAdminRefundableConditions, RefundBucket } from '../modules/batch-refund/refund-eligibility';

/**
 * 对账任务类型
 */
export type ReconcileKind = 'payment' | 'refund' | 'close';

/** 全选 ID 接口上限（与批量退款 DTO bookingIds 上限一致） */
export const ADMIN_BOOKING_IDS_MAX = 1000;

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

    /** 管理端订单筛选条件（订单列表 / 导出 / 全选 ID 共用，保证三处口径一致） */
    private applyAdminBookingFilters(
        qb: { andWhere: (...args: any[]) => any },
        query: {
            bookingDate?: string;
            createdStart?: string;
            createdEnd?: string;
            status?: BookingStatus[];
            keyword?: string;
        },
    ): void {
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

            this.applyAdminBookingFilters(qb, query);

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
     * 全选当前筛选结果（选择性批量退款配套）：返回与订单列表相同筛选下的全部订单 ID。
     * 超过 1000 个报错提示缩小范围（与批量退款 DTO 上限一致）。
     */
    async getBookingIdsForAdmin(query: {
        bookingDate?: string;
        createdStart?: string;
        createdEnd?: string;
        status?: BookingStatus[];
        keyword?: string;
    }): Promise<{ ids: string[]; total: number }> {
        const qb = this.bookingRepository
            .createQueryBuilder('booking')
            .select('booking.bookingId', 'bookingId')
            .orderBy('booking.createdAt', 'DESC')
            .addOrderBy('booking.id', 'DESC')
            .take(ADMIN_BOOKING_IDS_MAX + 1); // 多取一条用于超限检测

        this.applyAdminBookingFilters(qb, query);

        const rows = await qb.getRawMany<{ bookingId: string }>();
        if (rows.length > ADMIN_BOOKING_IDS_MAX) {
            throw new BadRequestException(`匹配订单超过 ${ADMIN_BOOKING_IDS_MAX} 个，请缩小筛选范围后再全选`);
        }
        return { ids: rows.map((r) => r.bookingId), total: rows.length };
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
            // 双保险（设计 2.1 原则 4）：批量退款 PENDING 订单尚未提交微信，
            // 对账查询必得 NOT_EXIST 会误判 FAILED，对账不得触碰未提交订单
            qb.andWhere(`(booking.refundSubmitStatus IS NULL OR booking.refundSubmitStatus != :pendingSubmit)`, {
                pendingSubmit: RefundSubmitStatus.PENDING,
            });
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

    /**
     * 退款查询第一次 NOT_EXIST：不判失败，打 REFUND_NOT_EXIST 标记并延迟复查
     * （设计 2.6「至少一次延迟查询确认」：微信建单与可查之间可能有传播延迟；
     * 复查仍 NOT_EXIST 才由调用方判 FAILED）。不累加 attempts、不升级异常。
     */
    async markRefundNotExistPending(bookingId: string, outRefundNo: string, nextAt: number, now: number): Promise<number> {
        return (await this.bookingRepository
            .createQueryBuilder()
            .update(Booking)
            .set({
                reconcileKind: 'refund',
                reconcileNextAt: nextAt,
                reconcileLastAt: now,
                reconcileLastErrorCode: 'REFUND_NOT_EXIST',
            })
            .where('bookingId = :bookingId', { bookingId })
            .andWhere('refundStatus = :rs', { rs: RefundStatus.REFUNDING })
            .andWhere('outRefundNo = :outRefundNo', { outRefundNo })
            .execute()).affected ?? 0;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 批量退款（资格查询 / 事务冻结 / worker 领取 / 进度聚合）
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * 选择性批量退款预览聚合：对给定订单 ID 列表逐单分类。
     * 可退（单数/金额/人数 + 掩码明细前 limit 条）+ 不可退分桶（附订单号，供管理端核对剔除）。
     * 分桶由 classifyAdminRefundEligibility（管理员资格模块）完成，保证预览与执行条件同源。
     */
    async getBatchRefundPreview(bookingIds: string[], now: number, detailLimit = 200) {
        const bookings = await this.bookingRepository
            .createQueryBuilder('booking')
            .where('booking.bookingId IN (:...ids)', { ids: bookingIds })
            .getMany();

        const buckets = new Map<Exclude<RefundBucket, 'refundable'>, string[]>();
        let refundable = 0;
        let totalAmount = 0;
        let peopleCount = 0;
        const details: Array<{ bookingId: string; name: string; phone: string; personCount: number; amount: number }> = [];

        for (const booking of bookings) {
            const bucket = classifyAdminRefundEligibility(booking, now);
            if (bucket === 'refundable') {
                refundable += 1;
                totalAmount += booking.amount ?? 0;
                peopleCount += booking.personCount ?? 0;
                if (details.length < detailLimit) {
                    details.push({
                        bookingId: booking.bookingId,
                        name: maskName(booking.name),
                        phone: maskPhone(booking.phone),
                        personCount: booking.personCount,
                        amount: booking.amount ?? 0,
                    });
                }
            } else {
                const list = buckets.get(bucket) ?? [];
                list.push(booking.bookingId);
                buckets.set(bucket, list);
            }
        }

        return {
            refundable: { count: refundable, totalAmount, peopleCount },
            unrefundable: Array.from(buckets.entries()).map(([reason, ids]) => ({ reason, count: ids.length, bookingIds: ids })),
            detailPreview: details,
        };
    }

    /**
     * 事务内批量冻结：对给定订单 ID 列表按管理员资金硬条件 UPDATE 为
     * REFUNDING + BATCH + PENDING + taskId，固定退款单号 RF{bookingId}。
     * 返回 affected（= totalTarget）；条件不满足的订单自动排除。
     *
     * 不设置 reconcile 调度字段（设计 2.1 原则 4）：PENDING 订单未提交微信，
     * 对账查询必得 NOT_EXIST 会被误判 FAILED；PENDING 的恢复只走 worker + Cron 兜底，
     * 对账在提交拿到应答后才排（markRefundSubmitted / markRefundSubmitUnknown）。
     */
    async freezeBookingsForBatchRefund(em: EntityManager, bookingIds: string[], taskId: string, now: number): Promise<number> {
        const qb = em
            .createQueryBuilder()
            .update(Booking)
            .set({
                refundStatus: RefundStatus.REFUNDING,
                refundSource: RefundSource.BATCH,
                refundSubmitStatus: RefundSubmitStatus.PENDING,
                refundBatchTaskId: taskId,
                // 固定退款单号：已有则保留（重试幂等），否则 RF + bookingId
                outRefundNo: () => `COALESCE(outRefundNo, 'RF' || bookingId)`,
            })
            .where('bookingId IN (:...ids)', { ids: bookingIds });

        applyAdminRefundableConditions(qb, '', now);
        const result = await qb.execute();
        return result.affected ?? 0;
    }

    /**
     * worker 领取：当前任务下一笔 PENDING 订单（按 id 升序，保证进度可预期）。
     * 每次只取一笔，不预加载全部目标（设计 2.12）。
     */
    async claimNextPendingBooking(taskId: string): Promise<Booking | null> {
        return this.bookingRepository
            .createQueryBuilder('booking')
            .where('booking.refundBatchTaskId = :taskId', { taskId })
            .andWhere('booking.refundSubmitStatus = :pending', { pending: RefundSubmitStatus.PENDING })
            .orderBy('booking.id', 'ASC')
            .getOne();
    }

    /**
     * worker 提交结果写回（条件更新：仅 PENDING 可推进，防回调/恢复并发竞争）
     * - SUBMITTED：已受理，转退款对账（15 分钟后）
     * - FAILED：微信明确拒绝，退款失败终态，清提交字段与调度
     * - UNKNOWN：保持 REFUNDING，1 分钟后先查询，不立即重复 POST
     */
    async markRefundSubmitted(bookingId: string, now: number): Promise<number> {
        return (await this.bookingRepository
            .createQueryBuilder()
            .update(Booking)
            .set({
                refundSubmitStatus: RefundSubmitStatus.SUBMITTED,
                refundSubmitErrorCode: null,
                reconcileKind: 'refund',
                reconcileNextAt: now + 15 * 60 * 1000,
                reconcileAttempts: 0,
                reconcileLastErrorCode: null,
            })
            .where('bookingId = :bookingId', { bookingId })
            .andWhere('refundSubmitStatus = :pending', { pending: RefundSubmitStatus.PENDING })
            .execute()).affected ?? 0;
    }

    async markRefundSubmitFailed(bookingId: string, errorCode: string): Promise<number> {
        return (await this.bookingRepository
            .createQueryBuilder()
            .update(Booking)
            .set({
                refundSubmitStatus: RefundSubmitStatus.FAILED,
                refundSubmitErrorCode: errorCode,
                refundStatus: RefundStatus.FAILED,
                reconcileKind: null,
                reconcileNextAt: null,
                reconcileAttempts: 0,
                reconcileLastErrorCode: null,
            })
            .where('bookingId = :bookingId', { bookingId })
            .andWhere('refundSubmitStatus = :pending', { pending: RefundSubmitStatus.PENDING })
            .execute()).affected ?? 0;
    }

    async markRefundSubmitUnknown(bookingId: string, errorCode: string, now: number): Promise<number> {
        return (await this.bookingRepository
            .createQueryBuilder()
            .update(Booking)
            .set({
                refundSubmitStatus: RefundSubmitStatus.UNKNOWN,
                refundSubmitErrorCode: errorCode,
                // 保持 refundStatus = REFUNDING；对账 1 分钟后先查询
                reconcileKind: 'refund',
                reconcileNextAt: now + 60 * 1000,
                reconcileAttempts: 0,
                reconcileLastErrorCode: null,
            })
            .where('bookingId = :bookingId', { bookingId })
            .andWhere('refundSubmitStatus = :pending', { pending: RefundSubmitStatus.PENDING })
            .execute()).affected ?? 0;
    }

    /**
     * 任务进度聚合（设计 2.7）：按 refundBatchTaskId 实时聚合互斥计数。
     * 互斥口径（约束 pending + processing + confirmed + failed = total）：
     *   pending    = refundSubmitStatus PENDING
     *   confirmed  = refundStatus REFUNDED
     *   failed     = refundStatus FAILED（含提交拒绝与回调/对账失败）
     *   processing = 其余（SUBMITTED/UNKNOWN 提交后、REFUNDING 中）
     */
    async aggregateBatchRefundProgress(taskId: string) {
        const rows = await this.bookingRepository
            .createQueryBuilder('booking')
            .select('COUNT(*)', 'total')
            .addSelect(`SUM(CASE WHEN booking.refundSubmitStatus = 'pending' THEN 1 ELSE 0 END)`, 'pending')
            .addSelect(`SUM(CASE WHEN booking.refundStatus = 'refunded' THEN 1 ELSE 0 END)`, 'confirmed')
            .addSelect(`SUM(CASE WHEN booking.refundStatus = 'failed' AND (booking.refundSubmitStatus IS NULL OR booking.refundSubmitStatus != 'pending') THEN 1 ELSE 0 END)`, 'failed')
            .addSelect(`SUM(CASE WHEN booking.refundStatus = 'refunded' THEN COALESCE(booking.amount, 0) ELSE 0 END)`, 'confirmedAmount')
            .where('booking.refundBatchTaskId = :taskId', { taskId })
            .getRawOne();

        const total = rows?.total ? Number(rows.total) : 0;
        const pending = rows?.pending ? Number(rows.pending) : 0;
        const confirmed = rows?.confirmed ? Number(rows.confirmed) : 0;
        const failed = rows?.failed ? Number(rows.failed) : 0;
        return {
            total,
            pending,
            confirmed,
            failed,
            processing: total - pending - confirmed - failed,
            confirmedAmount: rows?.confirmedAmount ? Number(rows.confirmedAmount) : 0,
        };
    }

    /**
     * 提交阶段是否完成：任务下已无 PENDING 订单
     */
    async countPendingByTaskId(taskId: string): Promise<number> {
        return this.bookingRepository.count({
            where: { refundBatchTaskId: taskId, refundSubmitStatus: RefundSubmitStatus.PENDING },
        });
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
 * 姓名掩码：保留姓氏，其余用 *（预览明细用，避免整列明文）
 */
function maskName(name?: string): string {
    if (!name) return '';
    if (name.length <= 1) return name;
    return name[0] + '*'.repeat(Math.min(name.length - 1, 3));
}

/**
 * 手机号掩码：保留前 3 后 4
 */
function maskPhone(phone?: string): string {
    if (!phone || phone.length < 7) return phone ?? '';
    return `${phone.substring(0, 3)}****${phone.substring(phone.length - 4)}`;
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
