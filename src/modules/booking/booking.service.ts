import { Injectable, BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource, EntityManager } from 'typeorm';
import { randomUUID } from 'crypto';
import { BookingRepository } from '../../repositories/booking.repository';
import { AdminApplicationRepository } from '../../repositories/admin-application.repository';
import { CreateBookingDto, PassengerDto } from './dto/createBooking.dto';
import { GetBookingsDto } from './dto/getBookings.dto';
import { UpdateBookingDto } from './dto/updateBooking.dto';
import { TimeSlot, TravelMode, VehicleType, BookingStatus, PaymentStatus, RefundStatus, Booking } from '../../entities/booking.entity';
import { AnomalyType, BookingAnomaly, AnomalyStatus } from '../../entities/booking-anomaly.entity';
import { SystemConfig } from '../../entities/system-config.entity';
import { WechatPayService, PaymentRequestError, WechatApiError, OrderQueryResult, CloseOrderResult, PaymentParams } from '../wechat-pay/wechat-pay.service';
import { SystemConfigService } from '../system-config/system-config.service';
import { MemberService } from '../member/member.service';
import { UserProfileRepository } from '../../repositories/user-profile.repository';
import { FreeEligibilityResult } from './dto/free-eligibility.dto';
import { normalizeIdCard } from '../../common/utils/id-card.util';
import { PaymentException, PaymentErrorCode } from '../../common/payment-errors';
import { isAutoRecoverable, nextAnomalyRetryAt } from './anomaly-policy';
import { BookingDashboardResponse } from '../admin/interfaces/booking-dashboard.interface';
import { LoggingService } from '../logging/logging.service';
import { AppLogLevel, AppLogSource, AppLogCategory } from '../../entities/app-log.entity';

/**
 * 支付准备整体预算（22 秒）。前端 25 秒超时为响应留出余量。
 */
const PAYMENT_PREPARATION_DEADLINE_MS = 22 * 1000;

/**
 * 支付准备成功结果缓存时长（30 秒）
 */
const PAYMENT_RESULT_CACHE_TTL_MS = 30 * 1000;

/**
 * 支付准备结果缓存最大条目数（惰性过期 + 超限时删除最早插入的条目）
 */
const PAYMENT_RESULT_CACHE_MAX = 200;

/**
 * 定时任务单轮运行时间预算（毫秒）。超过预算停止领取新订单，已开始的请求正常收尾。
 * 设计文档未给具体值，实现取 60 秒（见 implementation-todo.md 实现说明）。
 */
const TASK_TIME_BUDGET_MS = 60 * 1000;

/**
 * 微信下单「明确业务拒绝且未建单」的错误码枚举。
 * 只有这些码可以走 markPaymentStartRejected（恢复 UNPAID 保留单号）分支；
 * 其余业务错误一律视为结果未知，不能当作「未建单」（见 implementation-todo.md 待确认问题 3 补充）。
 */
const PAYMENT_START_REJECTED_CODES = new Set([
    'PARAM_ERROR',
    'INVALID_REQUEST',
    'NO_AUTH',
    'MCH_NOT_EXISTS',
    'APPID_MCHID_NOT_MATCH',
]);

type RecentPaymentResult = {
    value: PaymentParams;
    outTradeNo: string;
    expiresAt: number;
};

/**
 * 异常通道重试查询阶段的动作描述符：把「微信查询结果」转成「要对库做什么」，
 * 让微信 HTTP 在并发槽内完成（queryAnomalyAction），写库动作进单 writer FIFO（applyAnomalyAction）。
 */
type AnomalyRetryAction =
    | { kind: 'noop' }
    | { kind: 'backoff' }
    | { kind: 'resolve'; resolution: string }
    | { kind: 'paymentSucceeded'; transactionId: string | null; resolution: string }
    | { kind: 'paymentFailed'; resolution: string }
    | { kind: 'paymentClosed'; resolution: string }
    | { kind: 'refundSucceeded'; resolution: string }
    | { kind: 'refundFailed'; resolution: string };

/**
 * 全局微信对账并发信号量（后台所有微信任务共享，上限 2）
 */
class ReconcileSemaphore {
    private running = 0;
    private readonly waiters: (() => void)[] = [];

    constructor(private readonly max: number) {}

    async run<T>(fn: () => Promise<T>): Promise<T> {
        if (this.running >= this.max) {
            await new Promise<void>((resolve) => this.waiters.push(resolve));
        }
        this.running++;
        try {
            return await fn();
        } finally {
            this.running--;
            const next = this.waiters.shift();
            if (next) next();
        }
    }
}

/**
 * 预约订单业务逻辑层
 * 处理预约订单相关的业务逻辑
 */
@Injectable()
export class BookingService {
    private readonly logger = new Logger(BookingService.name);

    // ── 支付 single-flight 与短期结果缓存（进程内，不写库，Nest 重启后自然清空）──
    private readonly paymentFlights = new Map<string, Promise<PaymentParams>>();
    private readonly recentPaymentResults = new Map<string, RecentPaymentResult>();

    // ── 定时任务独立运行标记（防止自身重入）──
    private readonly taskRunning = {
        payment: false,
        close: false,
        refund: false,
        anomaly: false,
        anomalyCleanup: false,
        historical: false,
    };

    // ── 对账开关与批量/并发配置（payment-reliability-design.md「SQLite 写锁预算」）──
    // 发现锁等待上升时可先停后台对账（RECONCILIATION_ENABLED=false）或把批量降为 5，
    // 不影响微信回调主路径
    private readonly reconciliationEnabled = process.env.RECONCILIATION_ENABLED !== 'false';
    private readonly reconciliationBatchSize = parseInt(process.env.RECONCILIATION_BATCH_SIZE ?? '20', 10) || 20;
    private readonly reconciliationConcurrency = parseInt(process.env.RECONCILIATION_CONCURRENCY ?? '2', 10) || 2;

    // ── 后台微信任务全局并发限制（默认上限 2，支付/退款/关单/异常共享）──
    private readonly reconciliationSemaphore = new ReconcileSemaphore(
        parseInt(process.env.RECONCILIATION_CONCURRENCY ?? '2', 10) || 2,
    );

    // ── 单 SQLite writer：外部微信请求并发 2，结果写回始终串行 FIFO ──
    private writeChain: Promise<unknown> = Promise.resolve();
    private enqueueWrite(task: () => Promise<unknown>): Promise<unknown> {
        const result = this.writeChain.then(task, task);
        this.writeChain = result.catch(() => undefined);
        return result;
    }

    constructor(
        private readonly bookingRepository: BookingRepository,
        private readonly wechatPayService: WechatPayService,
        private readonly systemConfigService: SystemConfigService,
        private readonly adminApplicationRepository: AdminApplicationRepository,
        private readonly dataSource: DataSource,
        private readonly memberService: MemberService,
        private readonly userProfileRepository: UserProfileRepository,
        private readonly loggingService: LoggingService,
    ) {}


    /**
     * 创建预约订单
     * @param createBookingDto 创建订单数据
     * @returns 创建的订单
     */
    async createBooking(createBookingDto: CreateBookingDto & { wechatOpenId: string }) {
        // 检查是否允许预约（管理员 isAdmin=true 时跳过「关闭预约」开关）
        if (!createBookingDto.isAdmin) {
            const isBookingEnabled = await this.systemConfigService.isBookingEnabled();
            if (!isBookingEnabled) {
                const disabledMessage = await this.systemConfigService.getBookingDisabledMessage();
                throw new BadRequestException(disabledMessage);
            }
        }

        // 检查预约人数是否超过限制
        const timeSlotLimit = await this.systemConfigService.getTimeSlotLimit();
        // 已废弃上下午概念，morningMaxPeople 即全天总限额
        const maxPeople = timeSlotLimit.morningMaxPeople;

        // 获取当前日期的已预约人数
        const currentStats = await this.bookingRepository.getBookingStatsByDate(createBookingDto.bookingDate);
        const currentPeople = currentStats.morning.totalPeople + currentStats.afternoon.totalPeople;

        // 检查加上新预约的人数后是否超过限制
        if (currentPeople + createBookingDto.personCount > maxPeople) {
            // 记录点：容量不足（日志失败不影响业务结果）
            this.loggingService.write({
                source: AppLogSource.BACKEND,
                level: AppLogLevel.WARN,
                category: AppLogCategory.BOOKING,
                message: '预约创建失败：容量不足',
                route: '/bookings',
                context: { bookingDate: createBookingDto.bookingDate, personCount: createBookingDto.personCount, currentPeople, maxPeople },
            });
            throw new BadRequestException(`该日期预约人数已达上限，当前剩余名额：${Math.max(0, maxPeople - currentPeople)}`);
        }

        // 事务内：原子地判断免费资格并创建订单，避免并发下免费名额超卖
        let createdBooking: Booking;
        try {
            createdBooking = await this.dataSource.transaction(async (entityManager) => {
            const bookingRepo = entityManager.getRepository(Booking);
            const configRepo = entityManager.getRepository(SystemConfig);

            // SQLite 使用 DEFERRED 事务，读操作不会加锁，导致并发事务可能同时读到相同的免费名额计数后超卖。
            // 解决方案：在事务内最先执行一条写操作（对 system_configs 的无副作用 UPDATE），
            // 立即获取 SQLite RESERVED 锁，使后续并发的写事务阻塞等待，保证读-写串行化。
            await configRepo.createQueryBuilder().update(SystemConfig).set({ updatedAt: new Date() }).where('configId = :configId', { configId: 'system_config' }).execute();

            // 统一免费资格判定（与 preview 共用同一套逻辑），传入事务 EM 保证判定查询与抢锁在同一事务上下文
            const eligibility = await this.determineFreeEligibility(
                createBookingDto.wechatOpenId,
                createBookingDto.passengers,
                createBookingDto.bookingDate,
                createBookingDto.travelMode,
                createBookingDto.vehicleType,
                createBookingDto.licensePlate,
                { entityManager },
            );
            const { isFree, freeReason, amount } = eligibility;

            let status: BookingStatus;
            let paymentStatus: PaymentStatus;
            let paymentExpiredAt: Date | null;
            if (isFree) {
                // 免费订单：直接确认生效，跳过微信支付流程
                status = BookingStatus.CONFIRMED;
                paymentStatus = PaymentStatus.PAID;
                paymentExpiredAt = null;
            } else {
                // 收费订单：初始状态为待确认 + 未支付
                status = BookingStatus.PENDING;
                paymentStatus = PaymentStatus.UNPAID;
                paymentExpiredAt = new Date();
                paymentExpiredAt.setMinutes(paymentExpiredAt.getMinutes() + 30);
            }

            // 从 passengers[0] 同步联系人信息到兼容字段；身份证归一化（统一大写）写入
            const normalizedPassengers = createBookingDto.passengers.map((p) => ({
                ...p,
                idCard: normalizeIdCard(p.idCard),
            }));
            const firstPassenger = normalizedPassengers[0];
            const passengersJson = JSON.stringify(normalizedPassengers);

            // timeSlot 已不再区分上下午，统一存 morning（兼容历史数据与 NOT NULL 约束）
            if (!createBookingDto.timeSlot) {
                createBookingDto.timeSlot = TimeSlot.MORNING;
            }

            const bookingDate = new Date(createBookingDto.bookingDate);
            // 生成以 TL 开头的 11 位随机字符订单号
            const bookingId = `TL${randomUUID().replace(/-/g, '').substring(0, 11).toUpperCase()}`;

            // 创建订单
            const booking = bookingRepo.create({
                ...createBookingDto,
                bookingId,
                bookingDate,
                passengers: passengersJson,
                name: firstPassenger.name,
                phone: firstPassenger.phone,
                idCard: firstPassenger.idCard,
                isFree,
                freeReason,
                amount,
                status,
                paymentStatus,
                refundStatus: RefundStatus.NONE,
                paymentExpiredAt,
            });

            const savedBooking = await bookingRepo.save(booking);

            // 订单创建成功后，异步将乘客信息保存为常用联系人（按身份证号去重）
            // 不影响订单创建流程，即使保存失败也不阻断
            setImmediate(async () => {
                try {
                    await this.userProfileRepository.upsertProfiles(createBookingDto.wechatOpenId, normalizedPassengers);
                } catch (err) {
                    this.logger.warn(`自动保存常用联系人失败: ${err.message}`, err);
                }
            });

            return savedBooking;
            });
        } catch (error) {
            // 记录点：预约创建异常（日志失败不影响业务结果）
            this.loggingService.write({
                source: AppLogSource.BACKEND,
                level: AppLogLevel.ERROR,
                category: AppLogCategory.BOOKING,
                message: '预约创建异常',
                route: '/bookings',
                context: { bookingDate: createBookingDto.bookingDate, error: (error as Error).message },
            });
            throw error;
        }

        // 记录点：预约创建成功（日志失败不影响业务结果）
        this.loggingService.write({
            source: AppLogSource.BACKEND,
            level: AppLogLevel.INFO,
            category: AppLogCategory.BOOKING,
            message: '预约创建成功',
            route: '/bookings',
            context: { bookingId: createdBooking.bookingId, isFree: createdBooking.isFree, amount: createdBooking.amount },
        });
        return createdBooking;
    }

    /**
     * 统一免费资格判定（preview 与 createBooking 共用，保证预览结果与最终创建结果一致）
     * @param wechatOpenId 微信 OpenID（历史入参，会员判定不再依赖；保留以不破坏调用方）
     * @param passengers 出行人员列表
     * @param bookingDate 预约日期 (YYYY-MM-DD)
     * @param travelMode 出行方式（仅自驾+摩托车命中会员免费）
     * @param vehicleType 车辆类型（wheelMotorcycle 才查会员）
     * @param licensePlate 下单车牌号（须命中会员登记车牌其一）
     * @param options.entityManager 可选事务 EntityManager；preview 不传（用默认 EM 纯查询不抢锁），
     *                              createBooking 事务内传入事务 EM（判定查询与抢锁在同一事务上下文）
     *
     * 判定优先级：月卡会员（仅摩托车，身份证+车牌双匹配）→ 每日免费名额 → 收费。
     * freeReason（免费来源）与 reason（不能免费原因）互斥。
     */
    async determineFreeEligibility(
        wechatOpenId: string,
        passengers: PassengerDto[],
        bookingDate: string,
        travelMode?: TravelMode,
        vehicleType?: VehicleType,
        licensePlate?: string,
        options?: { entityManager?: EntityManager },
    ): Promise<FreeEligibilityResult> {
        const em = options?.entityManager ?? this.dataSource;
        const configRepo = em.getRepository(SystemConfig);
        const bookingRepo = em.getRepository(Booking);

        // 1. 读取支付配置（含每日免费名额配置）
        const config = await configRepo.findOne({ where: { configId: 'system_config' } });
        const paymentConfig = config?.paymentConfig ?? { paymentAmount: 0 };
        const unitPrice = paymentConfig.paymentAmount ?? 0;
        const freeEnabled = paymentConfig.freeQuotaEnabled === true;
        const freeLimit = paymentConfig.freeQuotaLimit ?? 100;

        // 2. 是否今天（仅预约日期为今天时才参与每日免费）
        // 用纯日期字符串比较，避免 new Date() 产生的 ISO 字符串与 SQLite date 列不一致
        const targetDateStr = bookingDate.length >= 10 ? bookingDate.substring(0, 10) : bookingDate;
        const todayDateStr = new Date().toISOString().substring(0, 10); // YYYY-MM-DD
        const bookingIsToday = targetDateStr === todayDateStr;
        // SQLite date 列只存日期，用纯日期字符串做范围查询
        const todayStart = todayDateStr;
        const nextDay = todayDateStr; // >= :todayStart AND <= :nextDay 即当天

        const personCount = passengers.length;

        // 3. 会员判定：仅「自驾 + 摩托车」才查会员，按身份证+车牌双匹配
        //    身份证：任一乘客身份证命中会员登记身份证
        //    车牌：下单车牌命中会员登记车牌（多个，分号分隔）其一
        const isMotorcycle = travelMode === TravelMode.SELF_DRIVING && vehicleType === VehicleType.WHEEL_MOTORCYCLE;
        let activeMember: Awaited<ReturnType<MemberService['getActiveMemberByIdCard']>> = null;
        let memberIdCardMatched = false;
        if (isMotorcycle) {
            // 遍历乘客身份证，找到第一个命中的有效会员
            for (const p of passengers) {
                const m = await this.memberService.getActiveMemberByIdCard(p.idCard);
                if (m) {
                    activeMember = m;
                    memberIdCardMatched = true;
                    break;
                }
            }
        }
        const memberInfo = activeMember
            ? {
                  isMember: true,
                  name: activeMember.name,
                  daysRemaining: Math.max(0, Math.ceil((activeMember.endDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24))),
              }
            : null;

        // 每日免费名额统计（修复 bug：仅统计 freeReason='dailyQuota'，排除会员订单）
        let quotaUsed = 0;
        let userHasFreeBooking = false;
        if (freeEnabled && bookingIsToday) {
            // 当日已用免费名额（去重用户数，仅算 dailyQuota，不含 member）
            const freeCountResult = await bookingRepo
                .createQueryBuilder('booking')
                .select('COUNT(DISTINCT booking.wechatOpenId)', 'count')
                .where('booking.isFree = :isFree', { isFree: true })
                .andWhere('booking.freeReason = :reason', { reason: 'dailyQuota' })
                .andWhere('booking.bookingDate >= :dayStart', { dayStart: todayStart })
                .andWhere('booking.bookingDate <= :nextDay', { nextDay })
                .getRawOne();
            quotaUsed = parseInt(freeCountResult?.count || '0', 10);

            // 当前用户今日是否已享过每日免费（同样仅算 dailyQuota）
            const userFreeCount = await bookingRepo
                .createQueryBuilder('booking')
                .where('booking.wechatOpenId = :openid', { openid: wechatOpenId })
                .andWhere('booking.isFree = :isFree', { isFree: true })
                .andWhere('booking.freeReason = :reason', { reason: 'dailyQuota' })
                .andWhere('booking.bookingDate >= :dayStart', { dayStart: todayStart })
                .andWhere('booking.bookingDate <= :nextDay', { nextDay })
                .getCount();
            userHasFreeBooking = userFreeCount > 0;
        }

        const freeQuotaInfo = {
            enabled: freeEnabled,
            limit: freeLimit,
            used: quotaUsed,
            remaining: Math.max(0, freeLimit - quotaUsed),
            bookingIsToday,
            userHasFreeBooking,
        };

        // 查询当天已预约总人数（pending + confirmed），用于前端展示"您是第 N 位预约"
        const targetDateStrForQuery = bookingDate.length >= 10 ? bookingDate.substring(0, 10) : bookingDate;
        const rankResult = await bookingRepo
            .createQueryBuilder('booking')
            .select('COALESCE(SUM(booking.personCount), 0)', 'totalPeople')
            .where('booking.bookingDate = :date', { date: targetDateStrForQuery })
            .andWhere('booking.status IN (:...activeStatuses)', { activeStatuses: ['pending', 'confirmed'] })
            .getRawOne();
        const bookingRank = parseInt(rankResult?.totalPeople || '0', 10);

        // 4. 会员免费命中：摩托车 + 身份证命中 + 车牌命中
        if (isMotorcycle && activeMember && memberIdCardMatched) {
            const memberPlates = activeMember.licensePlates
                ? activeMember.licensePlates.split(';').map((s) => s.toUpperCase().trim()).filter((s) => s.length > 0)
                : [];
            const inputPlate = (licensePlate ?? '').toUpperCase().trim();
            const plateMatched = inputPlate.length > 0 && memberPlates.includes(inputPlate);
            if (plateMatched) {
                return {
                    isFree: true,
                    freeReason: 'member',
                    reason: null,
                    amount: 0,
                    unitPrice,
                    personCount,
                    memberInfo,
                    freeQuotaInfo,
                    bookingRank,
                };
            }
        }

        // 5. 每日免费名额命中（仅会员未命中时）
        if (freeEnabled && bookingIsToday && !userHasFreeBooking && quotaUsed < freeLimit) {
            return {
                isFree: true,
                freeReason: 'dailyQuota',
                reason: null,
                amount: 0,
                unitPrice,
                personCount,
                memberInfo,
                freeQuotaInfo,
                bookingRank,
            };
        }

        // 6. 收费分支：按优先级定 reason
        //    摩托车且身份证命中会员但车牌未命中 → member_plate_not_matched
        //    摩托车但身份证未命中任何会员 → member_idcard_not_matched
        //    每日免费活动开启但名额用完/已享过/非今日 → daily_quota_* / not_today
        //    每日免费活动未开启（关闭）→ no_free_activity（活动隐藏，不向用户暴露免费相关文案）
        let reason: FreeEligibilityResult['reason'];
        if (isMotorcycle && activeMember && memberIdCardMatched) {
            // 身份证命中会员但车牌未命中（走到这里说明车牌比对失败）
            reason = 'member_plate_not_matched';
        } else if (isMotorcycle && !memberIdCardMatched) {
            // 摩托车但身份证未命中任何有效会员
            reason = 'member_idcard_not_matched';
        } else if (freeEnabled && bookingIsToday) {
            if (userHasFreeBooking) {
                reason = 'daily_quota_used';
            } else if (quotaUsed >= freeLimit) {
                reason = 'daily_quota_full';
            } else {
                // 名额未满且用户当日未享，理论上应在上一步命中 dailyQuota 免费；此处兜底
                reason = 'daily_quota_full';
            }
        } else if (freeEnabled && !bookingIsToday) {
            reason = 'not_today';
        } else {
            // !freeEnabled：每日免费活动未开启（活动隐藏），正常收费，不暴露免费相关文案
            reason = 'no_free_activity';
        }

        return {
            isFree: false,
            freeReason: null,
            reason,
            amount: personCount * unitPrice,
            unitPrice,
            personCount,
            memberInfo,
            freeQuotaInfo,
            bookingRank,
        };
    }

    /**
     * 更新预约订单
     * @param bookingId 订单ID
     * @param updateBookingDto 更新数据对象
     * @returns 更新后的订单
     */
    async updateBooking(bookingId: string, updateBookingDto: UpdateBookingDto) {
        return await this.bookingRepository.updateBooking(bookingId, updateBookingDto);
    }

    /**
     * 根据订单ID查询订单
     * @param bookingId 订单ID
     * @returns 订单详情
     */
    async getBookingById(bookingId: string, openid?: string) {
        const booking = await this.bookingRepository.getBookingById(bookingId);
        if (openid && booking.wechatOpenId !== openid) {
            throw new BadRequestException('无权访问该订单');
        }
        return booking;
    }

    /**
     * 查询订单列表 (分页)
     * @param query 查询条件 (包含分页参数)
     * @returns 订单列表和分页信息
     */
    async getBookings(query: GetBookingsDto & { wechatOpenId: string }) {
        return await this.bookingRepository.getBookings(query);
    }

    /**
     * 管理员查询订单列表（无 openid 限制）
     */
    async getBookingsForAdmin(query: { bookingDate?: string; createdStart?: string; createdEnd?: string; status?: BookingStatus[]; keyword?: string; page?: number; pageSize?: number }) {
        return await this.bookingRepository.getBookingsForAdmin(query);
    }

    /**
     * 统计当前用户指定状态下的订单数量
     * @param openid 用户 openid
     * @param status 可选，指定状态；不传则返回所有订单数量
     * @returns 订单数量
     */
    async countBookingsByStatus(openid: string, status?: BookingStatus): Promise<number> {
        return await this.bookingRepository.countBookingsByStatus(openid, status);
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
     * 经营统计聚合（管理员看板）
     * 校验日期范围：startDate <= endDate，最长 366 天；通过后转发 repository。
     */
    async getBookingDashboard(startDate: string, endDate: string): Promise<BookingDashboardResponse> {
        const start = startDate.length >= 10 ? startDate.substring(0, 10) : startDate;
        const end = endDate.length >= 10 ? endDate.substring(0, 10) : endDate;
        if (start > end) {
            throw new BadRequestException('开始日期不能晚于结束日期');
        }
        // 计算天数差（含起止），纯日期比较避免时区
        const [sy, sm, sd] = start.split('-').map(Number);
        const [ey, em, ed] = end.split('-').map(Number);
        const startMs = new Date(sy, sm - 1, sd).getTime();
        const endMs = new Date(ey, em - 1, ed).getTime();
        const days = Math.floor((endMs - startMs) / 86400000) + 1;
        if (days > 366) {
            throw new BadRequestException('统计日期范围不能超过366天');
        }
        return await this.bookingRepository.getBookingDashboard(start, end);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 支付发起（single-flight，固定执行顺序 10 步）
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * 初始化支付
     * @param bookingId 订单ID
     * @param openid 当前 JWT 用户（须为订单所有者）
     * @returns 支付参数
     */
    async initiatePayment(bookingId: string, openid: string) {
        // 步骤 1：读取订单并验证所有者、免费状态、订单状态和支付期限
        const booking = await this.bookingRepository.getBookingById(bookingId);
        if (booking.wechatOpenId !== openid) {
            throw new BadRequestException('无权操作该订单');
        }
        // 步骤 2：已支付订单返回稳定「订单已经支付」结果，不返回旧支付参数。
        // 必须在通用前置校验之前判断：assertPaymentPreconditions 对非 UNPAID/PAYING 状态
        // 会抛普通 BadRequestException（'订单状态不允许支付'），PAID 会命中那条，导致前端拿不到
        // ORDER_ALREADY_PAID 稳定错误码，只能显示通用失败文案。
        if (booking.paymentStatus === PaymentStatus.PAID || booking.status === BookingStatus.CONFIRMED) {
            throw new PaymentException(PaymentErrorCode.ORDER_ALREADY_PAID, '订单已经支付');
        }
        this.assertPaymentPreconditions(booking);

        // 步骤 3：命中未过期的成功结果缓存（须与数据库当前 outTradeNo 一致）
        const cached = this.recentPaymentResults.get(bookingId);
        if (cached) {
            const cacheValid =
                cached.expiresAt > Date.now() &&
                booking.status === BookingStatus.PENDING &&
                booking.paymentStatus === PaymentStatus.PAYING &&
                booking.paymentExpiredAt != null &&
                booking.paymentExpiredAt.getTime() > Date.now() &&
                booking.outTradeNo === cached.outTradeNo;
            if (cacheValid) {
                // 记录点：命中短期结果缓存
                this.loggingService.write({
                    source: AppLogSource.BACKEND,
                    level: AppLogLevel.INFO,
                    category: AppLogCategory.PAYMENT,
                    message: '支付准备命中短期缓存',
                    route: `/bookings/${bookingId}/pay`,
                    context: { bookingId, hitCache: true },
                });
                return cached.value;
            }
            // 任一条件不满足都立即逐出缓存，不能把已支付/已取消/退款中/已过期订单的旧参数返回前端
            this.recentPaymentResults.delete(bookingId);
        }

        // 步骤 4/5：已有 flight 则复用；否则同步创建 Promise 并立即放入 Map
        const existing = this.paymentFlights.get(bookingId);
        if (existing) {
            // 记录点：命中 single-flight（复用第一个请求的 Promise）
            this.loggingService.write({
                source: AppLogSource.BACKEND,
                level: AppLogLevel.INFO,
                category: AppLogCategory.PAYMENT,
                message: '支付准备命中 single-flight',
                route: `/bookings/${bookingId}/pay`,
                context: { bookingId, hitSingleFlight: true },
            });
            return existing;
        }
        const flight = this.executePaymentFlight(bookingId).finally(() => {
            const current = this.paymentFlights.get(bookingId);
            if (current === flight) {
                this.paymentFlights.delete(bookingId);
            }
        });
        this.paymentFlights.set(bookingId, flight);
        return flight;
    }

    /**
     * 支付准备公共前置校验（步骤 1 与 flight 内步骤 6 共用）
     */
    private assertPaymentPreconditions(booking: Booking) {
        if (booking.isFree) {
            throw new BadRequestException('该订单为免费预约，无需支付');
        }
        if (booking.status === BookingStatus.CANCELLED) {
            throw new BadRequestException('订单已取消，无法支付');
        }
        if (booking.paymentStatus !== PaymentStatus.UNPAID && booking.paymentStatus !== PaymentStatus.PAYING) {
            throw new BadRequestException('订单状态不允许支付');
        }
        if (booking.paymentExpiredAt && booking.paymentExpiredAt.getTime() <= Date.now()) {
            throw new BadRequestException('支付已超时');
        }
    }

    /**
     * single-flight 内执行支付准备（步骤 6-10）
     * 22 秒整体预算：关闭旧单与创建支付两个 HTTPS 请求共享同一个 AbortSignal
     */
    private async executePaymentFlight(bookingId: string): Promise<PaymentParams> {
        const controller = new AbortController();
        const deadline = setTimeout(() => controller.abort(), PAYMENT_PREPARATION_DEADLINE_MS);
        deadline.unref();
        const startMs = Date.now();
        const timings = { queryOldOrderMs: 0, closeOldOrderMs: 0, saveLocalMs: 0, createPaymentMs: 0 };

        try {
            // 步骤 6：flight 内再次读取订单并执行相同状态校验。
            // 已支付判断同样必须在通用前置校验之前，理由同步骤 2。
            const booking = await this.bookingRepository.getBookingById(bookingId);
            if (booking.paymentStatus === PaymentStatus.PAID || booking.status === BookingStatus.CONFIRMED) {
                throw new PaymentException(PaymentErrorCode.ORDER_ALREADY_PAID, '订单已经支付');
            }
            this.assertPaymentPreconditions(booking);
            // PAYING 但缺 outTradeNo：状态机不应产生（markPaymentStarting 原子写入 PAYING+outTradeNo），
            // 仅历史数据或外部错误修改会出现。记人工异常并按未知结果返回，避免盲目新建单号。
            if (booking.paymentStatus === PaymentStatus.PAYING && !booking.outTradeNo) {
                await this.bookingRepository.upsertAnomaly(
                    bookingId,
                    AnomalyType.PAYING_WITHOUT_OUT_TRADE_NO,
                    'PAYING_WITHOUT_OUT_TRADE_NO',
                    '本地 PAYING 但缺少 outTradeNo',
                    null,
                    Date.now(),
                );
                throw new PaymentException(PaymentErrorCode.PAYMENT_RESULT_UNKNOWN, '订单状态异常，请联系客服');
            }

            // 步骤 7：已有 outTradeNo 时先查询微信旧单
            // 用户交互路径必须用 interactiveAgent（设计「HTTPS Agent 隔离」），避免被后台对账 Agent 排队
            if (booking.outTradeNo) {
                const queryStart = Date.now();
                const query = await this.wechatPayService.queryOrder(booking.outTradeNo, {
                    agent: this.wechatPayService.interactiveAgent,
                    signal: controller.signal,
                });
                timings.queryOldOrderMs = Date.now() - queryStart;
                switch (query.state) {
                    case 'SUCCESS':
                        // 推进本地已支付并返回稳定结果
                        await this.bookingRepository.markPaymentSucceeded(booking.outTradeNo, query.transactionId ?? null, new Date());
                        await this.resolvePaymentAnomalies(bookingId, '支付准备时确认微信已支付', Date.now());
                        throw new PaymentException(PaymentErrorCode.ORDER_ALREADY_PAID, '订单已经支付');
                    case 'CLOSED':
                        // 微信侧已关闭：允许换单
                        break;
                    case 'NOT_EXIST':
                        // 明确不存在：允许换单；但本地 PAYING（本应已创建）记异常
                        if (booking.paymentStatus === PaymentStatus.PAYING) {
                            await this.bookingRepository.upsertAnomaly(
                                bookingId,
                                AnomalyType.REMOTE_ORDER_NOT_FOUND,
                                'ORDER_NOT_EXIST',
                                '本地 PAYING 但微信订单不存在',
                                nextAnomalyRetryAt(1, Date.now()),
                                Date.now(),
                            );
                        }
                        break;
                    case 'NOTPAY':
                    case 'USERPAYING': {
                        // 未支付活动态：必须结构化关单，只有明确关闭后才允许换单
                        const closeStart = Date.now();
                        const close = await this.wechatPayService.closeOrder(booking.outTradeNo, { signal: controller.signal });
                        timings.closeOldOrderMs = Date.now() - closeStart;
                        if (close.kind === 'CLOSED' || close.kind === 'ALREADY_CLOSED') {
                            break; // 允许换单
                        }
                        if (close.kind === 'ALREADY_PAID') {
                            // 查询/推进本地支付成功并停止创建新单（交互 Agent + 同一 AbortSignal）
                            const paidQuery = await this.wechatPayService.queryOrder(booking.outTradeNo, {
                                agent: this.wechatPayService.interactiveAgent,
                                signal: controller.signal,
                            });
                            await this.bookingRepository.markPaymentSucceeded(booking.outTradeNo, paidQuery.transactionId ?? null, new Date());
                            await this.resolvePaymentAnomalies(bookingId, '关单时发现已支付', Date.now());
                            throw new PaymentException(PaymentErrorCode.ORDER_ALREADY_PAID, '订单已经支付');
                        }
                        // UNKNOWN：不得继续换单
                        await this.bookingRepository.markPaymentResultUnknown(bookingId, booking.outTradeNo, close.errorCode ?? 'CLOSE_ORDER_UNKNOWN', Date.now());
                        throw new PaymentException(PaymentErrorCode.PAYMENT_RESULT_UNKNOWN, '支付准备结果未知，请稍后重试');
                    }
                    case 'UNKNOWN':
                    default:
                        // 查询或关单结果未知：返回 PAYMENT_RESULT_UNKNOWN
                        await this.bookingRepository.markPaymentResultUnknown(bookingId, booking.outTradeNo, query.errorCode ?? 'QUERY_ORDER_UNKNOWN', Date.now());
                        throw new PaymentException(PaymentErrorCode.PAYMENT_RESULT_UNKNOWN, '支付准备结果未知，请稍后重试');
                }
            }

            // 步骤 8：生成新 outTradeNo 并用条件 UPDATE 预写 PAYING/新单号/调度字段，成功后才调微信
            const newOutTradeNo = `${bookingId}${Date.now()}${randomUUID().replace(/-/g, '').substring(0, 6)}`;
            const now = Date.now();
            const saveStart = Date.now();
            const affected = await this.bookingRepository.markPaymentStarting(bookingId, booking.outTradeNo ?? null, newOutTradeNo, now + 5 * 60 * 1000, now);
            timings.saveLocalMs = Date.now() - saveStart;
            if (affected === 0) {
                // 订单已被其他流程推进（如支付成功回调），不能强行覆盖
                const fresh = await this.bookingRepository.getBookingById(bookingId);
                if (fresh.paymentStatus === PaymentStatus.PAID || fresh.status === BookingStatus.CONFIRMED) {
                    throw new PaymentException(PaymentErrorCode.ORDER_ALREADY_PAID, '订单已经支付');
                }
                throw new PaymentException(PaymentErrorCode.PAYMENT_RESULT_UNKNOWN, '订单状态已变化，请刷新后重试');
            }

            // 步骤 9：微信明确返回 prepay_id 后才生成并缓存支付参数
            let paymentParams: PaymentParams;
            try {
                const createStart = Date.now();
                paymentParams = await this.wechatPayService.createPayment(
                    newOutTradeNo,
                    booking.amount,
                    `预约订单 - ${booking.bookingDate}`,
                    booking.wechatOpenId,
                    booking.paymentExpiredAt,
                    controller.signal,
                );
                timings.createPaymentMs = Date.now() - createStart;
            } catch (error) {
                if (error instanceof PaymentRequestError) {
                    // abort/超时：不能证明微信未受理，保持 PAYING + 调度字段，对账接管
                    await this.bookingRepository.markPaymentResultUnknown(bookingId, newOutTradeNo, error.code, Date.now());
                    throw new PaymentException(PaymentErrorCode.PAYMENT_RESULT_UNKNOWN, '支付准备超时，请稍后重试');
                }
                if (error instanceof WechatApiError) {
                    const code = error.body?.code;
                    if (code && PAYMENT_START_REJECTED_CODES.has(code)) {
                        // 枚举内业务拒绝且确认未建单：恢复 UNPAID 保留单号，安排用户重试
                        await this.bookingRepository.markPaymentStartRejected(bookingId, newOutTradeNo, code);
                        throw new PaymentException(PaymentErrorCode.PAYMENT_START_REJECTED, '支付下单被拒绝，请稍后重试');
                    }
                    // 枚举外业务错误：无法确认是否建单，视为结果未知
                    await this.bookingRepository.markPaymentResultUnknown(bookingId, newOutTradeNo, code ?? 'PAYMENT_START_UNKNOWN', Date.now());
                    throw new PaymentException(PaymentErrorCode.PAYMENT_RESULT_UNKNOWN, '支付准备结果未知，请稍后重试');
                }
                // 其他异常（ECONNRESET、签名失败等）：本地已预写 PAYING + 新单号，保持并对账接管。
                // 统一转成稳定错误码 PAYMENT_RESULT_UNKNOWN，避免向 controller 泄漏非稳定 error。
                await this.bookingRepository.markPaymentResultUnknown(bookingId, newOutTradeNo, 'PAYMENT_START_UNKNOWN', Date.now());
                this.logger.warn(`支付下单其他异常，已转结果未知: ${bookingId} ${(error as Error)?.message}`);
                throw new PaymentException(PaymentErrorCode.PAYMENT_RESULT_UNKNOWN, '支付准备结果未知，请稍后重试');
            }

            // 步骤 9 续：缓存成功结果 30 秒（保存 outTradeNo 供命中时与数据库重新比较）
            this.recentPaymentResults.set(bookingId, {
                value: paymentParams,
                outTradeNo: newOutTradeNo,
                expiresAt: Date.now() + PAYMENT_RESULT_CACHE_TTL_MS,
            });
            this.trimRecentPaymentResults();
            await this.bookingRepository.resolveAnomaly(bookingId, AnomalyType.REMOTE_ORDER_NOT_FOUND, '换单成功', Date.now());

            // 记录点：支付准备成功（阶段耗时、同一 requestId）
            this.loggingService.write({
                source: AppLogSource.BACKEND,
                level: AppLogLevel.INFO,
                category: AppLogCategory.PAYMENT,
                message: '支付准备成功',
                route: `/bookings/${bookingId}/pay`,
                context: { bookingId, outTradeNo: newOutTradeNo, timings, totalMs: Date.now() - startMs },
            });
            return paymentParams;
        } catch (error) {
            // 记录点：支付准备失败（稳定错误码与耗时；日志失败不影响业务结果）
            this.loggingService.write({
                source: AppLogSource.BACKEND,
                level: AppLogLevel.ERROR,
                category: AppLogCategory.PAYMENT,
                message: '支付准备失败',
                route: `/bookings/${bookingId}/pay`,
                context: {
                    bookingId,
                    errorCode: error instanceof PaymentException ? error.code : (error as Error)?.message ?? 'UNKNOWN',
                    timings,
                    totalMs: Date.now() - startMs,
                },
            });
            throw error;
        } finally {
            clearTimeout(deadline);
        }
    }

    /**
     * 短期结果缓存最大条目限制（惰性清理：超出时删除最早插入的条目）
     */
    private trimRecentPaymentResults() {
        while (this.recentPaymentResults.size > PAYMENT_RESULT_CACHE_MAX) {
            const oldestKey = this.recentPaymentResults.keys().next().value;
            if (oldestKey === undefined) break;
            this.recentPaymentResults.delete(oldestKey);
        }
    }

    /**
     * 支付相关异常在成功/明确终态处理时自动标记 RESOLVED
     */
    private async resolvePaymentAnomalies(bookingId: string, resolution: string, now: number) {
        for (const type of [
            AnomalyType.PAYMENT_QUERY_REPEATED_FAILURE,
            AnomalyType.REMOTE_ORDER_NOT_FOUND,
            AnomalyType.PAYMENT_CREATED_LOCAL_SAVE_FAILED,
        ]) {
            await this.bookingRepository.resolveAnomaly(bookingId, type, resolution, now);
        }
    }

    /**
     * 查询支付状态
     * 仅查本地数据库，不请求微信 API。
     * 微信回调（POST /wechat-pay/notify）会异步更新支付状态，前端轮询只需读数据库即可。
     * @param bookingId 订单ID
     * @returns 支付状态
     */
    async getPaymentStatus(bookingId: string) {
        const booking = await this.bookingRepository.getBookingById(bookingId);
        if (!booking) {
            throw new BadRequestException('订单不存在');
        }

        return {
            status: booking.paymentStatus,
            paidAt: booking.paidAt ?? null,
            transactionId: booking.transactionId ?? null,
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 退款
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * 申请退款
     * markRefundStarting 条件 UPDATE 落库 REFUNDING + 调度字段后再调微信，
     * 并发重复提交由条件更新保证只有一次进入 REFUNDING
     * @param bookingId 订单ID
     * @returns 退款结果
     */
    async initiateRefund(bookingId: string, openid: string) {
        const booking = await this.bookingRepository.getBookingById(bookingId);
        if (!booking) {
            throw new BadRequestException('订单不存在');
        }

        if (booking.wechatOpenId !== openid) {
            throw new BadRequestException('无权操作该订单');
        }
        if (booking.isFree) {
            throw new BadRequestException('免费预约无需退款');
        }
        if (booking.status === BookingStatus.COMPLETED) {
            throw new BadRequestException('订单已完成，无法退款');
        }

        if (booking.paymentStatus !== PaymentStatus.PAID) {
            throw new BadRequestException('订单未支付，无法退款');
        }

        if (booking.refundStatus === RefundStatus.REFUNDED) {
            throw new BadRequestException('订单已退款');
        }

        if (booking.refundStatus === RefundStatus.REFUNDING) {
            throw new BadRequestException('退款申请处理中，请勿重复提交');
        }

        // 校验退款有效期：支付后一年内
        if (booking.paidAt) {
            const oneYearLater = new Date(booking.paidAt);
            oneYearLater.setFullYear(oneYearLater.getFullYear() + 1);
            if (new Date() > oneYearLater) {
                throw new BadRequestException('订单已超过退款有效期（支付后一年内）');
            }
        }

        // 幂等保护：固定退款单号（不含时间戳），保证重试时单号不变，避免重复退款
        const outRefundNo = booking.outRefundNo ?? `RF${booking.bookingId}`;

        // 条件更新：只有 CONFIRMED + PAID + refund NONE/FAILED 才能进入 REFUNDING
        const affected = await this.bookingRepository.markRefundStarting(bookingId, outRefundNo, Date.now() + 15 * 60 * 1000);
        if (affected === 0) {
            const fresh = await this.bookingRepository.getBookingById(bookingId);
            if (fresh.refundStatus === RefundStatus.REFUNDED) {
                throw new BadRequestException('订单已退款');
            }
            if (fresh.refundStatus === RefundStatus.REFUNDING) {
                throw new BadRequestException('退款申请处理中，请勿重复提交');
            }
            throw new BadRequestException('订单状态不允许退款');
        }

        // 申请退款；微信拒绝或结果未知时订单保持 REFUNDING，由退款对账任务接管
        try {
            const refundResult = await this.wechatPayService.refund(booking.outTradeNo, outRefundNo, booking.amount, booking.amount);
            // 记录点：退款申请成功（日志失败不影响业务结果）
            this.loggingService.write({
                source: AppLogSource.BACKEND,
                level: AppLogLevel.INFO,
                category: AppLogCategory.PAYMENT,
                message: '退款申请成功',
                route: `/bookings/${bookingId}/refund`,
                context: { bookingId, outRefundNo },
            });
            return refundResult;
        } catch (error) {
            // 记录点：退款申请失败（订单保持 REFUNDING，退款对账任务接管）
            this.loggingService.write({
                source: AppLogSource.BACKEND,
                level: AppLogLevel.WARN,
                category: AppLogCategory.PAYMENT,
                message: '退款申请失败',
                route: `/bookings/${bookingId}/refund`,
                context: { bookingId, outRefundNo, error: (error as Error).message },
            });
            throw error;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 定时任务（按分钟表错峰，Asia/Shanghai，秒固定 0）
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * 支付状态兜底：按 reconcileNextAt 查询到期且未过期的 PAYING 订单，每 5 分钟（00/05/.../55）
     */
    @Cron('0 0,5,10,15,20,25,30,35,40,45,50,55 * * * *', { timeZone: 'Asia/Shanghai' })
    async runPaymentReconciliation() {
        if (this.taskRunning.payment) return;
        if (!this.reconciliationEnabled) return;
        this.taskRunning.payment = true;
        const startedAt = Date.now();
        try {
            const candidates = await this.bookingRepository.findReconcileCandidates('payment', startedAt, this.reconciliationBatchSize);
            // 并发 2：不在循环内 await semaphore.run（那会退化为串行）。为每个候选发一个并发分片，
            // 收集后 Promise.all 等待；微信请求并发 2，结果按完成顺序进入单 writer FIFO 写回。
            const inflight: Promise<void>[] = [];
            for (const booking of candidates) {
                if (Date.now() - startedAt > TASK_TIME_BUDGET_MS) break; // 停止领取新订单
                if (!booking.outTradeNo) {
                    // PAYING 但缺 outTradeNo：历史数据或状态被外部错误修改，立即记人工异常并暂停正常通道
                    inflight.push(
                        (this.enqueueWrite(() =>
                            this.bookingRepository.upsertAnomaly(
                                booking.bookingId,
                                AnomalyType.PAYING_WITHOUT_OUT_TRADE_NO,
                                'PAYING_WITHOUT_OUT_TRADE_NO',
                                '本地 PAYING 但缺少 outTradeNo',
                                null, // 人工处理，不自动重试
                                Date.now(),
                            ),
                        ) as Promise<void>),
                    );
                    continue;
                }
                inflight.push(
                    this.reconciliationSemaphore.run(async () => {
                        const result = await this.wechatPayService.queryOrder(booking.outTradeNo);
                        this.enqueueWrite(() => this.applyPaymentReconcileResult(booking, result));
                    }),
                );
            }
            await Promise.allSettled(inflight);
            // 等待写回队列排空后才结束
            await this.writeChain;
            this.logTask('payment', AppLogLevel.INFO, '完成', { task: 'payment', scanned: candidates.length });
        } catch (error) {
            this.logger.error('支付状态兜底任务失败', error);
            this.logTask('payment', AppLogLevel.ERROR, '失败', { task: 'payment', error: (error as Error).message });
        } finally {
            this.taskRunning.payment = false;
        }
    }

    /**
     * 支付超时关单：每 5 分钟（02/07/.../57），与支付兜底错开 2 分钟
     */
    @Cron('0 2,7,12,17,22,27,32,37,42,47,52,57 * * * *', { timeZone: 'Asia/Shanghai' })
    async runPaymentTimeoutClose() {
        if (this.taskRunning.close) return;
        if (!this.reconciliationEnabled) return;
        this.taskRunning.close = true;
        const startedAt = Date.now();
        try {
            // 发现步骤：把所有已过期的 UNPAID/PAYING 订单标为 close 候选
            // （设计文档未明示发现步骤，见 implementation-todo.md 待确认问题 1）
            await this.bookingRepository.markCloseDue(startedAt);

            const candidates = await this.bookingRepository.findReconcileCandidates('close', startedAt, this.reconciliationBatchSize);
            const processedBookingIds: string[] = [];
            // 并发 2：不在循环内 await semaphore.run（那会退化为串行）。微信请求并发 2，
            // 结果按完成顺序进入单 writer FIFO 写回。微信 HTTP 必须在 enqueueWrite 之外执行。
            const inflight: Promise<void>[] = [];
            for (const booking of candidates) {
                if (Date.now() - startedAt > TASK_TIME_BUDGET_MS) break;
                if (booking.paymentStatus !== PaymentStatus.UNPAID && booking.paymentStatus !== PaymentStatus.PAYING) continue;

                if (!booking.outTradeNo) {
                    // 业务规则确认无需再关单（微信侧从未创建）
                    processedBookingIds.push(booking.bookingId);
                    continue;
                }

                inflight.push(
                    this.reconciliationSemaphore.run(async () => {
                        const close = await this.wechatPayService.closeOrder(booking.outTradeNo, {
                            agent: this.wechatPayService.reconciliationAgent,
                        });
                        // ALREADY_PAID 时先在并发槽内完成补查（微信 HTTP 不进写链），再写库
                        let paidTransactionId: string | null = null;
                        let isAlreadyPaid = false;
                        if (close.kind === 'ALREADY_PAID') {
                            isAlreadyPaid = true;
                            const paidQuery = await this.wechatPayService.queryOrder(booking.outTradeNo, {
                                agent: this.wechatPayService.reconciliationAgent,
                            });
                            paidTransactionId = paidQuery.transactionId ?? null;
                        }
                        this.enqueueWrite(async () => {
                            const now = Date.now();
                            if (close.kind === 'CLOSED' || close.kind === 'ALREADY_CLOSED') {
                                processedBookingIds.push(booking.bookingId);
                            } else if (isAlreadyPaid) {
                                // 重新查询订单并执行 markPaymentSucceeded，不关闭
                                await this.bookingRepository.markPaymentSucceeded(booking.outTradeNo, paidTransactionId, new Date());
                                await this.resolvePaymentAnomalies(booking.bookingId, '超时关单时发现已支付', now);
                            } else {
                                // UNKNOWN：保留当前状态，attempts 加一，下一关单轮（+2min）重试；
                                // 连续 3 次未知升级异常，暂停正常通道由异常任务接管
                                const nextAt = now + 2 * 60 * 1000;
                                await this.bookingRepository.markCloseResultUnknown(
                                    booking.bookingId,
                                    close.errorCode ?? 'CLOSE_ORDER_UNKNOWN',
                                    nextAt,
                                    now,
                                );
                                const fresh = await this.bookingRepository.getBookingById(booking.bookingId);
                                if (
                                    (fresh.paymentStatus === PaymentStatus.UNPAID || fresh.paymentStatus === PaymentStatus.PAYING)
                                    && fresh.reconcileAttempts >= 3
                                ) {
                                    await this.bookingRepository.escalateReconciliationAnomaly(
                                        fresh.bookingId,
                                        AnomalyType.CLOSE_ORDER_REPEATED_FAILURE,
                                        close.errorCode ?? 'CLOSE_ORDER_UNKNOWN',
                                        '关单连续失败',
                                        nextAnomalyRetryAt(fresh.reconcileAttempts, now),
                                    );
                                }
                            }
                        });
                    }),
                );
            }
            await Promise.allSettled(inflight);
            // 只更新本批已明确处理且当前状态仍符合条件的订单
            await this.enqueueWrite(() => this.bookingRepository.markPaymentClosed(processedBookingIds, startedAt));
            await this.writeChain;
            this.logTask('close', AppLogLevel.INFO, '完成', { task: 'close', scanned: candidates.length, closed: processedBookingIds.length });
        } catch (error) {
            this.logger.error('支付超时关单任务失败', error);
            this.logTask('close', AppLogLevel.ERROR, '失败', { task: 'close', error: (error as Error).message });
        } finally {
            this.taskRunning.close = false;
        }
    }

    /**
     * 退款对账：每 15 分钟（04/19/34/49）
     */
    @Cron('0 4,19,34,49 * * * *', { timeZone: 'Asia/Shanghai' })
    async runRefundReconciliation() {
        if (this.taskRunning.refund) return;
        if (!this.reconciliationEnabled) return;
        this.taskRunning.refund = true;
        const startedAt = Date.now();
        try {
            const candidates = await this.bookingRepository.findReconcileCandidates('refund', startedAt, this.reconciliationBatchSize);
            // 并发 2：不在循环内 await semaphore.run（那会退化为串行）。微信请求并发 2，
            // 结果按完成顺序进入单 writer FIFO 写回。
            const inflight: Promise<void>[] = [];
            for (const booking of candidates) {
                if (Date.now() - startedAt > TASK_TIME_BUDGET_MS) break;
                if (!booking.outRefundNo) continue;
                inflight.push(
                    this.reconciliationSemaphore.run(async () => {
                        const result = await this.wechatPayService.queryRefund(booking.outRefundNo);
                        this.enqueueWrite(() => this.applyRefundReconcileResult(booking, result));
                    }),
                );
            }
            await Promise.allSettled(inflight);
            await this.writeChain;
            this.logTask('refund', AppLogLevel.INFO, '完成', { task: 'refund', scanned: candidates.length });
        } catch (error) {
            this.logger.error('退款对账任务失败', error);
            this.logTask('refund', AppLogLevel.ERROR, '失败', { task: 'refund', error: (error as Error).message });
        } finally {
            this.taskRunning.refund = false;
        }
    }

    /**
     * 异常订单低频重试：每 30 分钟（08/38），每批最多 5 条，
     * 在全局并发上限内自身最多占 1 个微信请求
     */
    @Cron('0 8,38 * * * *', { timeZone: 'Asia/Shanghai' })
    async runAnomalyRetry() {
        if (this.taskRunning.anomaly) return;
        if (!this.reconciliationEnabled) return;
        this.taskRunning.anomaly = true;
        const startedAt = Date.now();
        try {
            const anomalies = await this.bookingRepository.findOpenAnomalies(startedAt, 5);
            for (const anomaly of anomalies) {
                if (Date.now() - startedAt > TASK_TIME_BUDGET_MS) break;
                if (!isAutoRecoverable(anomaly.type)) continue; // manual：暂停自动请求，等待人工处理

                // 处理前重新读取订单并验证当前业务状态仍然符合该异常
                let booking: Booking | null = null;
                try {
                    booking = await this.bookingRepository.getBookingById(anomaly.bookingId);
                } catch {
                    booking = null;
                }
                if (!booking) {
                    await this.enqueueWrite(() =>
                        this.bookingRepository.resolveAnomaly(anomaly.bookingId, anomaly.type, '订单不存在', Date.now()),
                    );
                    continue;
                }

                await this.reconciliationSemaphore.run(async () => {
                    // 微信 HTTP 必须在 enqueueWrite 之外执行（设计「微信请求绝不放在 SQLite 事务内」、
                    // 「外部并发 2 + SQLite 写入 1」）：先在并发槽内完成查询，再把结果写入交给单 writer FIFO。
                    const action = await this.queryAnomalyAction(booking, anomaly);
                    this.enqueueWrite(() => this.applyAnomalyAction(booking, anomaly, action));
                });
            }
            await this.writeChain;
            this.logTask('anomaly', AppLogLevel.INFO, '完成', { task: 'anomaly', scanned: anomalies.length });
        } catch (error) {
            this.logger.error('异常订单重试任务失败', error);
            this.logTask('anomaly', AppLogLevel.ERROR, '失败', { task: 'anomaly', error: (error as Error).message });
        } finally {
            this.taskRunning.anomaly = false;
        }
    }

    /**
     * 异常记录清理：每周日 03:16（Asia/Shanghai），与日志清理 03:21 相隔 5 分钟。
     * RESOLVED/IGNORED 在 resolvedAt 后保留 365 天；每批最多 100 条、单轮最多 10 批、批次间隔 100ms。
     * 只删除异常工作记录，不修改订单。
     */
    @Cron('0 16 3 * * 0', { timeZone: 'Asia/Shanghai' })
    async runAnomalyCleanup() {
        if (this.taskRunning.anomalyCleanup) return;
        this.taskRunning.anomalyCleanup = true;
        const cutoff = Date.now() - 365 * 24 * 60 * 60 * 1000;
        let totalDeleted = 0;
        try {
            for (let batch = 0; batch < 10; batch++) {
                const deleted = await this.bookingRepository.deleteResolvedAnomalies(cutoff, 100);
                totalDeleted += deleted;
                if (deleted < 100) break;
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            this.logger.log(`异常记录清理完成: 删除 ${totalDeleted} 条`);
            this.logTask('anomaly-cleanup', AppLogLevel.INFO, '完成', { task: 'anomaly-cleanup', deleted: totalDeleted });
        } catch (error) {
            this.logger.error('异常记录清理失败', error);
            this.logTask('anomaly-cleanup', AppLogLevel.ERROR, '失败', { task: 'anomaly-cleanup', error: (error as Error).message });
        } finally {
            this.taskRunning.anomalyCleanup = false;
        }
    }

    /**
     * 历史订单更新：每小时（13 分），不调用微信，保留批量 UPDATE
     */
    @Cron('0 13 * * * *', { timeZone: 'Asia/Shanghai' })
    async runHistoricalBookingUpdate() {
        if (this.taskRunning.historical) return;
        this.taskRunning.historical = true;
        try {
            const todayStart = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
            await this.bookingRepository.updatePastBookings(todayStart);
            this.logTask('historical', AppLogLevel.INFO, '完成', { task: 'historical' });
        } catch (error) {
            this.logger.error('历史订单更新任务失败', error);
            this.logTask('historical', AppLogLevel.ERROR, '失败', { task: 'historical', error: (error as Error).message });
        } finally {
            this.taskRunning.historical = false;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 对账结果应用（单 writer FIFO 写回）
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * 定时任务摘要日志（每轮一条，日志失败不影响任务结果）
     */
    private logTask(taskName: string, level: AppLogLevel, message: string, context?: unknown) {
        this.loggingService.write({
            source: AppLogSource.BACKEND,
            level,
            category: AppLogCategory.RUNTIME,
            message: `定时任务[${taskName}] ${message}`,
            context: context ?? { task: taskName },
        });
    }

    /**
     * 支付兜底结果应用
     */
    private async applyPaymentReconcileResult(booking: Booking, result: OrderQueryResult) {
        const now = Date.now();
        switch (result.state) {
            case 'SUCCESS':
                await this.bookingRepository.markPaymentSucceeded(booking.outTradeNo, result.transactionId ?? null, new Date());
                await this.resolvePaymentAnomalies(booking.bookingId, '支付对账确认成功', now);
                break;
            case 'CLOSED':
            case 'REVOKED':
            case 'PAYERROR':
                // 微信明确终态失败：按微信终态置 CANCELLED + FAILED，清空调度字段
                await this.bookingRepository.markPaymentFailed(booking.bookingId, booking.outTradeNo, PaymentStatus.FAILED, BookingStatus.CANCELLED);
                await this.resolvePaymentAnomalies(booking.bookingId, '支付对账确认微信终态失败', now);
                break;
            case 'NOTPAY':
            case 'USERPAYING':
                // 仍在正常处理中：保留状态，5 分钟后重查
                await this.bookingRepository.reschedulePaymentCheck(booking.bookingId, booking.outTradeNo, now + 5 * 60 * 1000, now);
                break;
            case 'NOT_EXIST':
                // 本地 PAYING 但微信侧无单：升级异常，暂停正常通道
                await this.bookingRepository.escalateReconciliationAnomaly(
                    booking.bookingId,
                    AnomalyType.REMOTE_ORDER_NOT_FOUND,
                    'ORDER_NOT_EXIST',
                    '本地 PAYING 但微信订单不存在',
                    nextAnomalyRetryAt(1, now),
                );
                break;
            case 'UNKNOWN':
            default:
                // 临时错误：attempts 加一，连续三次后升级异常
                await this.bookingRepository.markPaymentResultUnknown(booking.bookingId, booking.outTradeNo, result.errorCode ?? 'QUERY_ORDER_UNKNOWN', now);
                const fresh = await this.bookingRepository.getBookingById(booking.bookingId);
                if (fresh.paymentStatus === PaymentStatus.PAYING && fresh.reconcileAttempts >= 3) {
                    await this.bookingRepository.escalateReconciliationAnomaly(
                        fresh.bookingId,
                        AnomalyType.PAYMENT_QUERY_REPEATED_FAILURE,
                        result.errorCode ?? 'QUERY_ORDER_UNKNOWN',
                        '支付查询连续失败',
                        nextAnomalyRetryAt(fresh.reconcileAttempts, now),
                    );
                }
                break;
        }
    }

    /**
     * 退款对账结果应用
     */
    private async applyRefundReconcileResult(booking: Booking, result: any) {
        const now = Date.now();
        switch (result.state) {
            case 'SUCCESS':
                await this.bookingRepository.markRefundSucceeded(booking.bookingId, booking.outRefundNo, new Date());
                await this.bookingRepository.resolveAnomaly(booking.bookingId, AnomalyType.REFUND_QUERY_REPEATED_FAILURE, '退款对账确认成功', now);
                break;
            case 'CLOSED':
            case 'ABNORMAL':
            case 'NOT_EXIST':
                // 微信明确终态失败或退款单不存在：标记失败，清空调度字段
                await this.bookingRepository.markRefundFailed(booking.bookingId, booking.outRefundNo);
                await this.bookingRepository.resolveAnomaly(booking.bookingId, AnomalyType.REFUND_QUERY_REPEATED_FAILURE, '退款对账确认终态失败', now);
                break;
            case 'PROCESSING':
                // 仍在处理中：15 分钟后再查
                await this.bookingRepository.rescheduleRefundCheck(booking.bookingId, booking.outRefundNo, now + 15 * 60 * 1000, now);
                break;
            case 'UNKNOWN':
            default:
                // 临时错误：attempts 加一，连续三次后升级异常
                await this.bookingRepository.markRefundResultUnknown(booking.bookingId, booking.outRefundNo, result.errorCode ?? 'QUERY_REFUND_UNKNOWN', now);
                const fresh = await this.bookingRepository.getBookingById(booking.bookingId);
                if (fresh.refundStatus === RefundStatus.REFUNDING && fresh.reconcileAttempts >= 3) {
                    await this.bookingRepository.escalateReconciliationAnomaly(
                        fresh.bookingId,
                        AnomalyType.REFUND_QUERY_REPEATED_FAILURE,
                        result.errorCode ?? 'QUERY_REFUND_UNKNOWN',
                        '退款查询连续失败',
                        nextAnomalyRetryAt(fresh.reconcileAttempts, now),
                    );
                }
                break;
        }
    }

    /**
     * 异常通道重试的查询阶段：按异常类型发一次微信请求，返回「要应用什么动作」的描述符。
     * 微信 HTTP 在此阶段执行（位于 reconciliationSemaphore 并发槽内、enqueueWrite 之外），
     * 不阻塞单 writer 写链。仅查询，不写库。
     */
    private async queryAnomalyAction(booking: Booking, anomaly: BookingAnomaly): Promise<AnomalyRetryAction> {
        switch (anomaly.type) {
            case AnomalyType.PAYMENT_QUERY_REPEATED_FAILURE: {
                if (booking.paymentStatus !== PaymentStatus.PAYING || !booking.outTradeNo) {
                    return { kind: 'resolve', resolution: '订单状态已变化' };
                }
                const r = await this.wechatPayService.queryOrder(booking.outTradeNo);
                if (r.state === 'SUCCESS') {
                    return { kind: 'paymentSucceeded', transactionId: r.transactionId ?? null, resolution: '异常通道重试确认支付成功' };
                }
                if (r.state === 'CLOSED' || r.state === 'REVOKED' || r.state === 'PAYERROR') {
                    return { kind: 'paymentFailed', resolution: '异常通道重试确认微信终态失败' };
                }
                return { kind: 'backoff' };
            }
            case AnomalyType.REFUND_QUERY_REPEATED_FAILURE: {
                if (booking.refundStatus !== RefundStatus.REFUNDING || !booking.outRefundNo) {
                    return { kind: 'resolve', resolution: '订单状态已变化' };
                }
                const r = await this.wechatPayService.queryRefund(booking.outRefundNo);
                if (r.state === 'SUCCESS') {
                    return { kind: 'refundSucceeded', resolution: '异常通道重试确认退款成功' };
                }
                if (r.state === 'CLOSED' || r.state === 'ABNORMAL' || r.state === 'NOT_EXIST') {
                    return { kind: 'refundFailed', resolution: '异常通道重试确认退款终态' };
                }
                return { kind: 'backoff' };
            }
            case AnomalyType.CLOSE_ORDER_REPEATED_FAILURE: {
                if (booking.paymentStatus !== PaymentStatus.UNPAID && booking.paymentStatus !== PaymentStatus.PAYING) {
                    return { kind: 'resolve', resolution: '订单状态已变化' };
                }
                if (!booking.outTradeNo) {
                    return { kind: 'resolve', resolution: '无微信单号，无需关单' };
                }
                const r = await this.wechatPayService.closeOrder(booking.outTradeNo, { agent: this.wechatPayService.reconciliationAgent });
                if (r.kind === 'CLOSED' || r.kind === 'ALREADY_CLOSED') {
                    return { kind: 'paymentClosed', resolution: '异常通道重试关单成功' };
                }
                if (r.kind === 'ALREADY_PAID') {
                    const paidQuery = await this.wechatPayService.queryOrder(booking.outTradeNo);
                    return { kind: 'paymentSucceeded', transactionId: paidQuery.transactionId ?? null, resolution: '异常通道重试关单时发现已支付' };
                }
                return { kind: 'backoff' };
            }
            case AnomalyType.REMOTE_ORDER_NOT_FOUND: {
                // 本地 PAYING 但微信曾查不到单：重查一次；仍不存在或未知则退避（人工介入）
                if (booking.paymentStatus !== PaymentStatus.PAYING || !booking.outTradeNo) {
                    return { kind: 'resolve', resolution: '订单状态已变化' };
                }
                const r = await this.wechatPayService.queryOrder(booking.outTradeNo);
                if (r.state === 'SUCCESS') {
                    return { kind: 'paymentSucceeded', transactionId: r.transactionId ?? null, resolution: '异常通道重试确认微信已支付' };
                }
                if (r.state === 'CLOSED' || r.state === 'REVOKED' || r.state === 'PAYERROR') {
                    // 仅对明确支付终态失败置 FAILED/CANCELLED
                    return { kind: 'paymentFailed', resolution: '异常通道重试确认微信终态' };
                }
                // NOT_EXIST/UNKNOWN/NOTPAY/USERPAYING/REFUND：仍活动或不确定，按退避重排，不能取消进行中的支付
                return { kind: 'backoff' };
            }
            case AnomalyType.LOCAL_REMOTE_STATUS_MISMATCH: {
                // 本地与微信终态冲突：重查对齐
                if (!booking.outTradeNo) {
                    return { kind: 'resolve', resolution: '无微信单号' };
                }
                const r = await this.wechatPayService.queryOrder(booking.outTradeNo);
                if (r.state === 'SUCCESS') {
                    return { kind: 'paymentSucceeded', transactionId: r.transactionId ?? null, resolution: '异常通道重试确认支付成功' };
                }
                if (r.state === 'CLOSED' || r.state === 'REVOKED' || r.state === 'PAYERROR') {
                    return { kind: 'paymentFailed', resolution: '异常通道重试确认微信终态' };
                }
                return { kind: 'backoff' };
            }
            case AnomalyType.PAYMENT_CREATED_LOCAL_SAVE_FAILED: {
                // 微信下单成功但本地保存失败：检查订单是否已被回调/其他流程推进
                if (booking.paymentStatus === PaymentStatus.PAID || booking.status === BookingStatus.CONFIRMED) {
                    return { kind: 'resolve', resolution: '订单已被推进' };
                }
                if (booking.paymentStatus === PaymentStatus.PAYING && booking.outTradeNo) {
                    const r = await this.wechatPayService.queryOrder(booking.outTradeNo);
                    if (r.state === 'SUCCESS') {
                        return { kind: 'paymentSucceeded', transactionId: r.transactionId ?? null, resolution: '异常通道重试确认支付成功' };
                    }
                    if (r.state === 'CLOSED' || r.state === 'REVOKED' || r.state === 'PAYERROR') {
                        return { kind: 'paymentFailed', resolution: '异常通道重试确认微信终态' };
                    }
                }
                return { kind: 'backoff' };
            }
            default:
                // manual 等类型不在此处理（调用方已跳过）
                return { kind: 'noop' };
        }
    }

    /**
     * 异常通道重试的写库阶段：把查询阶段返回的动作应用到 DB（位于 enqueueWrite 内，单 writer 串行）。
     */
    private async applyAnomalyAction(booking: Booking, anomaly: BookingAnomaly, action: AnomalyRetryAction) {
        const now = Date.now();
        switch (action.kind) {
            case 'resolve':
                await this.bookingRepository.resolveAnomaly(booking.bookingId, anomaly.type, action.resolution, now);
                return;
            case 'backoff':
                await this.bookingRepository.rescheduleAnomalyRetry(booking.bookingId, anomaly.type, nextAnomalyRetryAt(anomaly.occurrenceCount, now));
                return;
            case 'paymentSucceeded':
                await this.bookingRepository.markPaymentSucceeded(booking.outTradeNo, action.transactionId, new Date());
                await this.resolvePaymentAnomalies(booking.bookingId, action.resolution, now);
                return;
            case 'paymentFailed':
                await this.bookingRepository.markPaymentFailed(booking.bookingId, booking.outTradeNo, PaymentStatus.FAILED, BookingStatus.CANCELLED);
                await this.resolvePaymentAnomalies(booking.bookingId, action.resolution, now);
                return;
            case 'refundSucceeded':
                await this.bookingRepository.markRefundSucceeded(booking.bookingId, booking.outRefundNo, new Date());
                await this.bookingRepository.resolveAnomaly(booking.bookingId, anomaly.type, action.resolution, now);
                return;
            case 'refundFailed':
                await this.bookingRepository.markRefundFailed(booking.bookingId, booking.outRefundNo);
                await this.bookingRepository.resolveAnomaly(booking.bookingId, anomaly.type, action.resolution, now);
                return;
            case 'paymentClosed':
                await this.bookingRepository.markPaymentClosed([booking.bookingId], now);
                await this.bookingRepository.resolveAnomaly(booking.bookingId, anomaly.type, action.resolution, now);
                return;
            case 'noop':
            default:
                return;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 核验
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * 核验订单（管理员扫码）
     * 将 CONFIRMED 订单标记为 COMPLETED
     * @param bookingId 订单ID
     * @param openid 操作者 openid
     */
    async verifyBooking(bookingId: string, openid: string) {
        const admin = await this.adminApplicationRepository.findApprovedByOpenid(openid);
        if (!admin) {
            throw new ForbiddenException('无核验权限');
        }

        const booking = await this.bookingRepository.getBookingById(bookingId);

        if (booking.status !== BookingStatus.CONFIRMED) {
            // 记录点：核验失败（日志失败不影响业务结果）
            this.loggingService.write({
                source: AppLogSource.BACKEND,
                level: AppLogLevel.WARN,
                category: AppLogCategory.BOOKING,
                message: '预约核验失败',
                route: `/bookings/${bookingId}/verify`,
                context: { bookingId, currentStatus: booking.status },
            });
            throw new BadRequestException(`订单状态不可核验，当前状态：${booking.status}`);
        }

        const updated = await this.bookingRepository.updateBooking(bookingId, { status: BookingStatus.COMPLETED } as any);
        // 记录点：核验成功
        this.loggingService.write({
            source: AppLogSource.BACKEND,
            level: AppLogLevel.INFO,
            category: AppLogCategory.BOOKING,
            message: '预约核验成功',
            route: `/bookings/${bookingId}/verify`,
            context: { bookingId },
        });
        return updated;
    }

    /**
     * 根据商户订单号查询订单
     * @param outTradeNo 商户订单号
     * @returns 订单
     */
    async getBookingByOutTradeNo(outTradeNo: string) {
        return await this.bookingRepository.getBookingByOutTradeNo(outTradeNo);
    }

    /**
     * 获取全量订单（供导出用），支持与列表相同的筛选条件，不分页
     */
    async getAllBookingsForExport(query: { bookingDate?: string; createdStart?: string; createdEnd?: string; status?: BookingStatus[]; keyword?: string }) {
        return await this.bookingRepository.getAllBookingsForExport(query);
    }
}
