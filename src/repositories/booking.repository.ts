import { Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not, LessThan, Like } from 'typeorm';
import { Booking, BookingStatus, PaymentStatus, RefundStatus, TravelMode } from '../entities/booking.entity';
import { BookingAnomaly, AnomalyType, AnomalyStatus } from '../entities/booking-anomaly.entity';
import { CreateBookingDto } from '../modules/booking/dto/createBooking.dto';
import { GetBookingsDto } from '../modules/booking/dto/getBookings.dto';
import { DataSource, EntityManager } from 'typeorm';
import { randomUUID } from 'crypto';
import { BookingDashboardResponse } from '../modules/admin/interfaces/booking-dashboard.interface';
import { serialSave, serialTransaction, serialWrite } from '../common/transaction-runner';
import { MESSAGE_QUIET_WINDOW_MS } from '../modules/message/message-policy';

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

            const savedBooking = await serialSave(this.bookingRepository, booking);
            return Array.isArray(savedBooking) ? savedBooking[0] : savedBooking;
        } catch (error) {
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to create booking');
        }
    }

    /**
     * 更新预约订单
     *
     * ⚠️ 非原子写：读-改-写（Object.assign + save），并发下会丢失更新。
     * 仅供内部已持有写锁或幂等覆盖的场景使用（如核销置 completed）；
     * **状态流转一律用下方带期望状态条件的条件更新原语**，不要新增调用点。
     *
     * @param bookingId 订单ID
     * @param patch 要写入的字段（不再耦合 HTTP 层的 DTO，避免接口字段收窄波及内部调用）
     * @returns 更新后的订单实体
     */
    async updateBooking(bookingId: string, patch: Partial<Booking>): Promise<Booking> {
        try {
            const booking = await this.getBookingById(bookingId);

            // bookingDate 传字符串时需转 Date；传 Date 或 null 时保持原值语义
            if (typeof (patch as any).bookingDate === 'string') {
                (patch as any).bookingDate = new Date((patch as any).bookingDate);
            }

            Object.assign(booking, patch);
            return await serialSave(this.bookingRepository, booking);
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
     * markExpired：把「预约日已过且仍未核销」的订单置为已过期。
     *
     * **取代 `updatePastBookings`**（已删除）——后者把同样的行置为 `completed`，
     * 使「没来」与「来过」在数据上再也无法区分。详见 `BookingStatus` 上方的语义说明。
     *
     * ⚠️ **边界必须是纯日期字符串，不要传 `Date`**（2026-09-13 修正）。
     * 原实现沿用 `updatePastBookings` 的 `todayStart: Date`，在 UTC+8 下"碰巧"正确、
     * 在 UTC 下会**把当天的订单也置为 expired**。原因见下方实测记录：
     *
     *   TypeORM 对 `where` 里的 `Date` 参数走 `DateUtils.mixedDateToUtcDatetimeString`，
     *   绑定值是 **UTC 分量**的 `'2026-09-13 00:00:00.000'`；而 `bookingDate` 列存的是
     *   纯 `'2026-09-13'`。字符串比较下 `'2026-09-13' < '2026-09-13 00:00:00.000'`
     *   **为真**（短串是长串的前缀），于是「< 今天」变成了「≤ 今天」，当天订单被误伤。
     *
     *   实测（同一份数据：昨天/今天/明天各一单 confirmed）：
     *     TZ=UTC+8  → 绑定 `'2026-09-12 16:00:00.000'` → 只有昨天 expired ✓（碰巧对）
     *     TZ=UTC    → 绑定 `'2026-09-13 00:00:00.000'` → **今天也 expired** ✗
     *
     *   即谓词的正确性依赖进程时区，而 `Date` 只在 UTC+8 下才把边界落在昨天。
     *   改为传日期字符串后 `bookingDate < '2026-09-13'` 是严格比较，与时区无关，
     *   且在 UTC+8 下与改动前的结果集**完全等价**（{bookingDate ≤ 昨天}）。
     *
     *   本仓其余 13 处 `bookingDate` 比较（免费名额、看板、当日查询）一律传日期字符串，
     *   只有此处传过 `Date`——修正后与全仓惯例一致。
     *   回归锁定：`booking-expire.spec.ts` 把进程时区强制为 UTC 后跑边界用例，
     *   且参数类型是 `string`，退回 `Date` 会直接编译失败。
     *
     * 两条关键设计：
     * - **条件更新**，与核销 `markVerified` 严格互斥：两者都要求 `status='confirmed'`，
     *   谁先成功谁生效，后到者 affected=0。（若无条件写，核销晚于 T1 落地就会把
     *   已过期订单写回 completed，等价于一次绕过审核的补核销。）
     * - **排除 `refundStatus IN (refunding, refunded)`**：退款中的订单 `status` 仍为
     *   `confirmed`（见 `markRefundStarting`），旧实现会把它们错置成 `completed`——
     *   这是现存缺陷（§8 第 4 条），本期一并修掉。
     *
     * @param todayStr 今天（Asia/Shanghai）的 `YYYY-MM-DD`，直接用 `beijingDateStr()`
     * @param now 当前时刻（epoch ms），写入 `expiredAt`
     * @returns affected rows
     */
    async markExpired(todayStr: string, now: number): Promise<number> {
        return serialWrite(this.dataSource, async () => (await this.bookingRepository
            .createQueryBuilder()
            .update(Booking)
            .set({ status: BookingStatus.EXPIRED, expiredAt: new Date(now) })
            .where('bookingDate < :todayStr', { todayStr })
            .andWhere('status = :status', { status: BookingStatus.CONFIRMED })
            .andWhere('refundStatus NOT IN (:...refundStatuses)', {
                refundStatuses: [RefundStatus.REFUNDING, RefundStatus.REFUNDED],
            })
            .execute()).affected ?? 0);
    }

    /**
     * T1 步骤②：取「已过期但尚未通知」的订单（§4.2.3）
     *
     * 与步骤①（`markExpired`）**完全解耦**：①只改状态，本方法只管挑出该发通知的，
     * 两者各自可重入。v1 用「`expiredAt` 落在本轮扫描窗口内」挑选待通知订单，
     * 某轮扫描中途失败/进程重启时，那批订单的 `expiredAt` 已写入而通知未发，
     * 下一轮它们的 `expiredAt` 早于窗口下限——**永远不再被取到**。
     * `dedupeKey` 只防重复，不防漏发；标记位（`expireNotifiedAt IS NULL`）才能防漏发。
     *
     * `createdAt <= now - quietWindowMs` 是 A 规则（见 `message-policy.ts`）。**不满足的订单
     * 不写标记位**，下轮继续被取到，到期后自然补发——不会永久漏发。
     *
     * 排序 `expiredAt ASC` + LIMIT：积压时按「过期最久」优先补发，
     * 每轮消化一批而不是一次性倾泻（理由见 `MESSAGE_SCAN_BATCH_LIMIT`）。
     *
     * @param now 当前时刻（epoch ms）
     * @param quietWindowMs 静默期。cron 路径传 `MESSAGE_QUIET_WINDOW_MS`（2h）；
     *                      手动触发可覆盖，0 = 不设静默期（测试用）
     */
    async findExpiredNotNotified(limit: number, now: number, quietWindowMs: number): Promise<Booking[]> {
        return await this.bookingRepository
            .createQueryBuilder('booking')
            .where('booking.status = :status', { status: BookingStatus.EXPIRED })
            .andWhere('booking.expireNotifiedAt IS NULL')
            .andWhere('booking.createdAt <= :notifyCutoff', {
                notifyCutoff: now - quietWindowMs,
            })
            .orderBy('booking.expiredAt', 'ASC')
            .limit(limit)
            .getMany();
    }

    /**
     * T2 ①：取「今天预约、仍未核销」的订单（每日 22:00 提醒核销）
     *
     * `bookingDate = :todayStr` 必须传**日期字符串**而不是 `Date`：
     * `bookingDate` 是 `type:'date'`、存纯 `'YYYY-MM-DD'`，而 TypeORM 对 `where` 里的
     * `Date` 参数绑定的是 UTC 分量的 `'YYYY-MM-DD HH:mm:ss.SSS'`，字符串比较下
     * 「相等」永远不成立（长串 ≠ 短串）。详见 `markExpired` 的注释与
     * `implementation-todo.md` 说明 23。
     *
     * 只取 `createdAt <= now - quietWindowMs`（A 规则）：当天很晚下单的用户当晚不推，
     * 次日 22:00 时若订单已过期，由 ② 补推。
     *
     * @param quietWindowMs 静默期，语义同 `findExpiredNotNotified`
     */
    async findTodayUnverified(todayStr: string, limit: number, now: number, quietWindowMs: number): Promise<Booking[]> {
        return await this.bookingRepository
            .createQueryBuilder('booking')
            .where('booking.status = :status', { status: BookingStatus.CONFIRMED })
            .andWhere('booking.bookingDate = :todayStr', { todayStr })
            .andWhere('booking.createdAt <= :notifyCutoff', {
                notifyCutoff: now - quietWindowMs,
            })
            .orderBy('booking.createdAt', 'ASC')
            .limit(limit)
            .getMany();
    }

    /**
     * T2 ②：取「近 N 天已过期、从未通知、且没有进行中的退款」的订单（兜底 + 唤回）
     *
     * 三个条件的用意（§4.2.4）：
     *   · `expireNotifiedAt IS NULL` —— 兜底 T1 的漏发（进程重启/任务失败）；
     *   · `refundStatus = 'none'` —— **进行中/已退款的不能再推「可申请退款」**，
     *     否则文案与事实矛盾（用户明明已经在等审核，却收到「你可以申请退款」）；
     *   · 近 N 天窗口 —— 与退款申请时限**同源**（调用方传
     *     `getRefundApplyDeadlineDays()` 换算的毫秒数），保证提醒只落在「还能退」的区间内。
     *
     * 窗口天数由调用方给，本方法不读配置：仓库层不持有业务配置，
     * 且「7」这个数字在方案里明确要求与申请时限对齐，抄第二遍必然漂移。
     */
    async findExpiredForRefundReminder(limit: number, now: number, windowMs: number): Promise<Booking[]> {
        return await this.bookingRepository
            .createQueryBuilder('booking')
            .where('booking.status = :status', { status: BookingStatus.EXPIRED })
            .andWhere('booking.expireNotifiedAt IS NULL')
            .andWhere('booking.refundStatus = :refundStatus', { refundStatus: RefundStatus.NONE })
            .andWhere('booking.expiredAt >= :windowStart', { windowStart: now - windowMs })
            .orderBy('booking.expiredAt', 'ASC')
            .limit(limit)
            .getMany();
    }

    /**
     * 写入「已过期通知已发出」标记位（T1 ② / T2 ② 的收尾动作）
     *
     * 带 `expireNotifiedAt IS NULL` 条件：并发下只有一方 affected=1，另一方 0。
     * 取值本身是幂等的（同一个 bookingId 写同一个语义），条件是为了**可观测**——
     * 若将来有人误在循环外调用它，affected 会立刻暴露问题。
     *
     * ⚠️ 调用时机是「**已发出或早已存在**」（`sendOrderExpired` 返回 true），
     * 被每日配额挡住时**不能**写：写了就等于放弃补发。
     */
    async markExpireNotified(bookingId: string, now: number): Promise<number> {
        return serialWrite(this.dataSource, async () => (await this.bookingRepository
            .createQueryBuilder()
            .update(Booking)
            .set({ expireNotifiedAt: new Date(now) })
            .where('bookingId = :bookingId', { bookingId })
            .andWhere('expireNotifiedAt IS NULL')
            .execute()).affected ?? 0);
    }

    /**
     * markVerified：核销（扫码）——条件更新 + 留痕。
     *
     * **取代 `updateBooking(bookingId, { status: COMPLETED })`**：那是
     * `Object.assign` + save 的**无条件写**，与 T1 的 `markExpired` 并发时后写者赢。
     * 若核销在 T1 之后落地，会把已过期的订单又写回 `completed`——
     * 等价于一次**绕过审核的补核销**，而 Q2 明确不允许补核销（§4.1.1）。
     *
     * 只要求 `status='confirmed'`，与改动前 `verifyBooking` 的前置校验等价，
     * 不引入新的限制条件（如 paymentStatus / refundStatus），避免改变既有可核销范围。
     *
     * @param bookingId 订单ID
     * @param verifierOpenid 核销人 openid（留痕；改动前日志 context 里不含核销人）
     * @param now 核销时刻（epoch ms）
     * @returns affected rows（0 = 状态已不是 confirmed，如已被 T1 翻成 expired）
     */
    async markVerified(bookingId: string, verifierOpenid: string, now: number): Promise<number> {
        return serialWrite(this.dataSource, async () => (await this.bookingRepository
            .createQueryBuilder()
            .update(Booking)
            .set({
                status: BookingStatus.COMPLETED,
                verifiedAt: new Date(now),
                verifiedBy: verifierOpenid,
            })
            .where('bookingId = :bookingId', { bookingId })
            .andWhere('status = :status', { status: BookingStatus.CONFIRMED })
            .execute()).affected ?? 0);
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

        // 构造 qb 不碰数据库，只有 execute() 才下发语句 —— 排队只需罩住它
        return serialWrite(this.dataSource, async () => (await qb.execute()).affected ?? 0);
    }

    /**
     * markPaymentStartRejected：微信明确拒绝且未建单 → UNPAID，保留 outTradeNo，
     * 清空 payment 调度字段，保留稳定错误码
     */
    async markPaymentStartRejected(bookingId: string, outTradeNo: string, errorCode: string): Promise<number> {
        return serialWrite(this.dataSource, async () => (await this.bookingRepository
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
            .execute()).affected ?? 0);
    }

    /**
     * markPaymentResultUnknown：微信请求结果未知 → 保持 PAYING，
     * reconcileKind=payment、reconcileNextAt=now、attempts 加一，记录稳定错误码
     */
    async markPaymentResultUnknown(bookingId: string, outTradeNo: string, errorCode: string, now: number): Promise<number> {
        return serialWrite(this.dataSource, async () => (await this.bookingRepository
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
            .execute()).affected ?? 0);
    }

    /**
     * reschedulePaymentCheck：支付对账仍未支付 → 保持业务状态，设置下一次执行时间，清空本次临时错误
     */
    async reschedulePaymentCheck(bookingId: string, outTradeNo: string, nextAt: number, now: number): Promise<number> {
        return serialWrite(this.dataSource, async () => (await this.bookingRepository
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
            .execute()).affected ?? 0);
    }

    /**
     * markPaymentSucceeded：支付成功回调/对账（最高优先级确认）。
     * 非支付终态且 outTradeNo 相同 → CONFIRMED + PAID，写 transactionId/paidAt，清空全部调度字段
     */
    async markPaymentSucceeded(outTradeNo: string, transactionId: string | null, paidAt: Date): Promise<number> {
        return serialWrite(this.dataSource, async () => (await this.bookingRepository
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
            .execute()).affected ?? 0);
    }

    /**
     * markPaymentFailed：支付对账明确终态失败 → 按微信终态设为 FAILED/CANCELLED，清空调度字段
     */
    async markPaymentFailed(bookingId: string, outTradeNo: string, paymentStatus: PaymentStatus, bookingStatus: BookingStatus): Promise<number> {
        return serialWrite(this.dataSource, async () => (await this.bookingRepository
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
            .execute()).affected ?? 0);
    }

    /**
     * markCloseDue：支付到期待关单 → 保持业务状态，reconcileKind=close、reconcileNextAt=now。
     * 发现步骤：扫描所有已过期的 UNPAID/PAYING 订单（含从未发起支付、无调度字段的订单）。
     */
    async markCloseDue(now: number): Promise<number> {
        return serialWrite(this.dataSource, async () => (await this.bookingRepository
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
            .execute()).affected ?? 0);
    }

    /**
     * markPaymentClosed：超时关单只更新本批已明确处理且当前状态仍符合条件的订单。
     * processedBookingIds 只包含微信明确关单成功、明确已关闭或业务规则确认无需关单的订单。
     */
    async markPaymentClosed(bookingIds: string[], now: number): Promise<number> {
        if (bookingIds.length === 0) return 0;
        return serialWrite(this.dataSource, async () => (await this.bookingRepository
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
            .execute()).affected ?? 0);
    }

    /**
     * markCancelledByUser：用户主动取消「待支付」订单。
     *
     * 条件更新（不是 updateBooking 那种读-改-写），与支付回调、关单对账、超时关单三方互斥：
     * 只有当前仍是 `status=pending AND paymentStatus=unpaid` 的行才会被改写，返回 affected rows。
     *
     * 为什么只允许 UNPAID：
     * markPaymentStarting 在调微信**之前**就原子写入 `PAYING + outTradeNo`，
     * 而 markPaymentStartRejected 在微信明确拒绝（未建单）时退回 UNPAID。
     * 因此 `paymentStatus = UNPAID` 严格等价于「微信侧必定不存在预支付单」，
     * 此时清空 close 对账调度是安全的（没有单需要关）。
     * PAYING 则可能已在微信侧建单、钱随时可能落到账上，不能在这里杀掉，
     * 必须交给已有的超时关单对账流程判定，否则会出现「已取消却收到钱」。
     *
     * 终态字段与 markPaymentClosed 保持一致（cancelled + failed + 清空调度），
     * 使两条路径产出的终态完全相同，下游无需区分订单是超时关闭还是用户取消。
     *
     * @param bookingId 订单ID
     * @returns affected rows（0 表示订单已被其他流程推进，调用方应报「状态已变化」）
     */
    async markCancelledByUser(bookingId: string): Promise<number> {
        return serialWrite(this.dataSource, async () => (await this.bookingRepository
            .createQueryBuilder()
            .update(Booking)
            .set({
                status: BookingStatus.CANCELLED,
                paymentStatus: PaymentStatus.FAILED,
                reconcileKind: null,
                reconcileNextAt: null,
            })
            .where('bookingId = :bookingId', { bookingId })
            .andWhere('status = :status', { status: BookingStatus.PENDING })
            .andWhere('paymentStatus = :paymentStatus', { paymentStatus: PaymentStatus.UNPAID })
            .execute()).affected ?? 0);
    }

    /**
     * markCloseResultUnknown：关单结果未知（网络超时/解析失败）→ 保持业务状态，
     * reconcileKind=close、reconcileNextAt 重排到下一关单轮、attempts 加一、记录稳定错误码。
     * 与 markPaymentResultUnknown 对称的关单临时失败计数（设计表格未列，见 implementation-todo.md）。
     */
    async markCloseResultUnknown(bookingId: string, errorCode: string, nextAt: number, now: number): Promise<number> {
        return serialWrite(this.dataSource, async () => (await this.bookingRepository
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
            .execute()).affected ?? 0);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 退款转换协议条件更新
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * markRefundStarting：CONFIRMED **或 EXPIRED** + PAID + refund NONE/FAILED → REFUNDING，
     * 写 outRefundNo，reconcileKind=refund、reconcileNextAt=now+15min，attempts 清零。
     * 保持 status 不变、paymentStatus=paid（状态变化留待退款终态）。
     *
     * ── 为什么放宽到 `expired`（2026-09-13，阶段 3）────────────────────────────
     * 过期订单的退款出口是「用户申请 → 管理员审核 → 通过后调 `initiateRefund`」，
     * 而 `initiateRefund` 的落库动作就是本方法。过期单 `status='expired'`，
     * 不改这里则条件恒不满足、`affected` 恒为 0——**退款永远发不出去**，
     * 且错误信息会误导成「订单状态不允许退款」（§4.3.3.1 改动 1）。
     *
     * ── 这是全方案唯一触碰并发临界区的地方 ────────────────────────────────────
     * 放开之后，仓库层对过期单的 status 守卫就不再拦截自助退款了。此时过期订单
     * 唯一的自助退款拦截面是 `initiateRefund` 里的 `status === EXPIRED && !asAdmin` 判断，
     * 而该判断已在阶段 2A 提前落地（见 implementation-todo.md 说明 22）。
     * **顺序是硬的**：先有 service 层拦截，才有这里放开；反过来会出现
     * 「用户点旧入口直接退款」的窗口，审核制形同虚设。
     *
     * 条件更新本身仍是「谁先成功谁生效」：管理员审核通过路径与其它任何并发退款发起
     * 只有一方 affected=1。
     *
     * `markRefundSucceeded/Failed` 的 WHERE 只判 `refundStatus` 与 `outRefundNo`、不判 `status`，
     * 因此 `expired → refunded` 天然成立，退款终态不需要任何改动。
     */
    async markRefundStarting(bookingId: string, outRefundNo: string, nextAt: number): Promise<number> {
        return serialWrite(this.dataSource, async () => (await this.bookingRepository
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
            .andWhere('status IN (:...statuses)', {
                statuses: [BookingStatus.CONFIRMED, BookingStatus.EXPIRED],
            })
            .andWhere('paymentStatus = :ps', { ps: PaymentStatus.PAID })
            .andWhere('refundStatus IN (:...refundStatuses)', {
                refundStatuses: [RefundStatus.NONE, RefundStatus.FAILED],
            })
            .execute()).affected ?? 0);
    }

    /**
     * markRefundSucceeded：退款回调或对账成功 → 退款成功终态，写 refundedAt，清空调度字段
     */
    async markRefundSucceeded(bookingId: string, outRefundNo: string, refundedAt: Date): Promise<number> {
        return serialWrite(this.dataSource, async () => (await this.bookingRepository
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
            .execute()).affected ?? 0);
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
        // 经事务串行器排队：sqlite 全进程一条连接，两处并发事务会打坏 BEGIN/COMMIT 记账
        // （本方法由对账 cron 循环调用，与用户下单的事务同源冲突），见 common/transaction-runner.ts
        await serialTransaction(this.dataSource, async (em) => {
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
        return serialTransaction(this.dataSource, async (em) => {
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
        return serialWrite(this.dataSource, async () => (await this.anomalyRepository
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
            .execute()).affected ?? 0);
    }

    /**
     * 经营统计聚合（按预约游玩日期 bookingDate 筛选）
     *
     * 口径（与设计 1.3 一致）：
     * - 有效预约状态：confirmed、completed
     * - 实收金额：paymentStatus=paid 且状态在 receivedStatuses 内的 amount 之和（**口径与「量」不同，见下**）
     * - 自驾车辆数：有效订单中 travelMode=selfDriving 且 licensePlate 非空，一单一车
     * - 状态分布：范围内全部订单按六种状态计数
     * - 出行方式分布：仅统计有效订单
     * - dailyTrend：按 bookingDate 分组，无数据日期补 0，保证连续
     *
     * 【实收金额与「量」的口径为何分开】（2026-09-13 起）
     * 「有效订单数/总人数/车辆数」回答「有多少人真的来了」，expired 没来，不算；
     * 「实收金额」回答「钱还在不在景区手上」，expired 未退款，钱仍在手上，要算。
     * 两者分母不同是**有意为之**：若不这样拆，T1 上线后同一批订单由 completed 变 expired，
     * 实收金额会凭空下降。代价是可能出现「某天有效订单 0 但实收 > 0」（当天订单全过期），
     * 这是口径正确的表现，不是 bug，**不要**再把 expired 加回 validStatuses 去"修"它。
     *
     * SQLite bookingDate 为纯日期字符串，直接用 >= / <= 比较，不转 Date。
     */
    async getBookingDashboard(startDate: string, endDate: string): Promise<BookingDashboardResponse> {
        try {
            // 截取为 YYYY-MM-DD，纯字符串比较
            const start = startDate.length >= 10 ? startDate.substring(0, 10) : startDate;
            const end = endDate.length >= 10 ? endDate.substring(0, 10) : endDate;

            const validStatuses: BookingStatus[] = [BookingStatus.CONFIRMED, BookingStatus.COMPLETED];
            /** 计入实收的状态集：比 validStatuses 多一个 expired（钱还在手上，见方法注释） */
            const receivedStatuses: BookingStatus[] = [...validStatuses, BookingStatus.EXPIRED];
            const allStatuses: BookingStatus[] = [
                BookingStatus.PENDING,
                BookingStatus.CONFIRMED,
                BookingStatus.COMPLETED,
                BookingStatus.CANCELLED,
                BookingStatus.REFUNDED,
                // 必须逐个列出：下面是按 allStatuses 组装结果的，漏掉的状态即使 SQL 数出来了也会被丢掉
                BookingStatus.EXPIRED,
            ];
            const allTravelModes: TravelMode[] = [TravelMode.SCENIC_BUS, TravelMode.SELF_DRIVING, TravelMode.TOUR_GROUP];

            // 1) summary：有效订单数 / 总人数 / 自驾车辆数 / 免费&收费人数
            //    不含实收金额——它的状态口径不同，单独查（见下方 2)）
            const summaryRow = await this.bookingRepository
                .createQueryBuilder('booking')
                .select('COUNT(*)', 'validOrderCount')
                .addSelect('SUM(booking.personCount)', 'totalPeople')
                .addSelect("SUM(CASE WHEN booking.travelMode = :selfDriving AND booking.licensePlate IS NOT NULL AND booking.licensePlate != '' THEN 1 ELSE 0 END)", 'selfDrivingVehicleCount')
                .addSelect("SUM(CASE WHEN booking.isFree = 1 THEN booking.personCount ELSE 0 END)", 'freePeople')
                .addSelect("SUM(CASE WHEN booking.isFree = 0 THEN booking.personCount ELSE 0 END)", 'paidPeople')
                .where('booking.bookingDate >= :start', { start })
                .andWhere('booking.bookingDate <= :end', { end })
                .andWhere('booking.status IN (:...validStatuses)', { validStatuses })
                .setParameter('selfDriving', TravelMode.SELF_DRIVING)
                .getRawOne();

            // 2) 实收金额：口径是「钱在不在手上」，故用 receivedStatuses（含 expired），与上面不同。
            //    按 bookingDate 分组一次查出，summary 求和、dailyTrend 逐日取值，避免查两遍。
            const receivedRows = await this.bookingRepository
                .createQueryBuilder('booking')
                .select('booking.bookingDate', 'date')
                .addSelect("SUM(CASE WHEN booking.paymentStatus = :paid THEN COALESCE(booking.amount, 0) ELSE 0 END)", 'receivedAmount')
                .where('booking.bookingDate >= :start', { start })
                .andWhere('booking.bookingDate <= :end', { end })
                .andWhere('booking.status IN (:...receivedStatuses)', { receivedStatuses })
                .setParameter('paid', PaymentStatus.PAID)
                .groupBy('booking.bookingDate')
                .getRawMany<{ date: string; receivedAmount: string | number }>();

            const receivedByDate = new Map<string, number>();
            let receivedTotal = 0;
            for (const row of receivedRows) {
                // 与 dailyTrend 同样处理：SQLite date 列读出可能是 'YYYY-MM-DD' 或 Date 对象
                const dateStr = String(row.date).substring(0, 10);
                const amount = toNumber(row.receivedAmount);
                receivedByDate.set(dateStr, amount);
                receivedTotal += amount;
            }

            // 3) statusDistribution：范围内全部订单按状态计数（不排除任何状态）
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

            // 4) travelModeDistribution：仅统计有效订单，返回订单数与人数
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

            // 5) dailyTrend：按 bookingDate 分组的有效订单聚合，再补齐无数据日期
            //    同样不含实收金额（口径不同），由 2) 的 receivedByDate 提供
            const dailyRows = await this.bookingRepository
                .createQueryBuilder('booking')
                .select('booking.bookingDate', 'date')
                .addSelect('COUNT(*)', 'validOrderCount')
                .addSelect('SUM(booking.personCount)', 'peopleCount')
                .addSelect("SUM(CASE WHEN booking.travelMode = :selfDriving AND booking.licensePlate IS NOT NULL AND booking.licensePlate != '' THEN 1 ELSE 0 END)", 'selfDrivingVehicleCount')
                .where('booking.bookingDate >= :start', { start })
                .andWhere('booking.bookingDate <= :end', { end })
                .andWhere('booking.status IN (:...validStatuses)', { validStatuses })
                .setParameter('selfDriving', TravelMode.SELF_DRIVING)
                .groupBy('booking.bookingDate')
                .orderBy('booking.bookingDate', 'ASC')
                .getRawMany<{
                    date: string;
                    validOrderCount: string | number;
                    peopleCount: string | number;
                    selfDrivingVehicleCount: string | number;
                }>();

            const dailyMap = new Map<string, { validOrderCount: number; peopleCount: number; selfDrivingVehicleCount: number }>();
            for (const row of dailyRows) {
                // SQLite date 列读出可能是 'YYYY-MM-DD' 或 Date 对象，统一截取前 10 位
                const dateStr = String(row.date).substring(0, 10);
                dailyMap.set(dateStr, {
                    validOrderCount: toNumber(row.validOrderCount),
                    peopleCount: toNumber(row.peopleCount),
                    selfDrivingVehicleCount: toNumber(row.selfDrivingVehicleCount),
                });
            }

            const dailyTrend = fillDateRange(start, end).map((dateStr) => ({
                date: dateStr,
                validOrderCount: dailyMap.get(dateStr)?.validOrderCount ?? 0,
                peopleCount: dailyMap.get(dateStr)?.peopleCount ?? 0,
                selfDrivingVehicleCount: dailyMap.get(dateStr)?.selfDrivingVehicleCount ?? 0,
                // 可能 >0 而 validOrderCount=0（当天订单全部过期）：口径不同所致，非缺陷
                receivedAmount: receivedByDate.get(dateStr) ?? 0,
            }));

            return {
                range: { startDate: start, endDate: end },
                summary: {
                    validOrderCount: toNumber(summaryRow?.validOrderCount),
                    totalPeople: toNumber(summaryRow?.totalPeople),
                    selfDrivingVehicleCount: toNumber(summaryRow?.selfDrivingVehicleCount),
                    receivedAmount: receivedTotal,
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
