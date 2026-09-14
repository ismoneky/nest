import { Injectable, BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource, EntityManager } from 'typeorm';
import { randomUUID } from 'crypto';
import { BookingRepository } from '../../repositories/booking.repository';
import { AdminApplicationRepository } from '../../repositories/admin-application.repository';
import { RefundApplyRepository } from '../../repositories/refund-apply.repository';
import { CreateBookingDto, PassengerDto } from './dto/createBooking.dto';
import { GetBookingsDto } from './dto/getBookings.dto';
import { TimeSlot, TravelMode, VehicleType, BookingStatus, PaymentStatus, RefundStatus, Booking } from '../../entities/booking.entity';
import { AnomalyType, BookingAnomaly, AnomalyStatus } from '../../entities/booking-anomaly.entity';
import { SystemConfig, PaymentConfig } from '../../entities/system-config.entity';
import { WechatPayService, PaymentRequestError, WechatApiError, OrderQueryResult, CloseOrderResult, PaymentParams } from '../wechat-pay/wechat-pay.service';
import { SystemConfigService } from '../system-config/system-config.service';
import { MemberService } from '../member/member.service';
import { UserProfileRepository } from '../../repositories/user-profile.repository';
import { DailyFreeQuotaInfo, FreeEligibilityResult } from './dto/free-eligibility.dto';
import { TodayQuotaOverview } from './dto/today-quota.dto';
import { normalizeIdCard } from '../../common/utils/id-card.util';
import { PaymentException, PaymentErrorCode } from '../../common/payment-errors';
import { BookingException, BookingErrorCode } from '../../common/booking-errors';
import { PassengerBusinessException, PassengerErrorCode } from '../../common/passenger-business.exception';
import { serialTransaction, serialWrite } from '../../common/transaction-runner';
import {
    AgePricingSummary,
    calculateAgePricing,
    PassengerPricingResult,
    validatePassengerBusinessRules,
    validatePassengerLimit,
} from './passenger-pricing';
import { isAutoRecoverable, nextAnomalyRetryAt } from './anomaly-policy';
import { BookingDashboardResponse } from '../admin/interfaces/booking-dashboard.interface';
import { LoggingService } from '../logging/logging.service';
import { AppLogLevel, AppLogSource, AppLogCategory } from '../../entities/app-log.entity';
import { beijingDateStr } from '../../common/date-utils';
import { MessageService } from '../message/message.service';
import {
    MESSAGE_QUIET_WINDOW_MAX_MS,
    MESSAGE_QUIET_WINDOW_MS,
    MESSAGE_SCAN_BATCH_LIMIT,
} from '../message/message-policy';
import { resolveApplyDeadlineStr } from '../refund/refund-deadline';
import { MessageType } from '../../entities/message.entity';

/**
 * 支付准备整体预算（22 秒）。前端 25 秒超时为响应留出余量。
 */
const PAYMENT_PREPARATION_DEADLINE_MS = 22 * 1000;

/**
 * 今日名额「紧张」阈值：剩余 <= 总限额 × 本比例 时，接口才下发精确剩余数字。
 *
 * 【为什么需要这个阈值】单价是公开的，故 已约人数 × 单价 ≈ 每日营收。而
 * 「剩余 = 总量 − 已约」，若一直下发精确剩余，任何人从当天 00:00 开始轮询、
 * 取首尾差值就等于当天的已约人数 —— 根本不需要知道总量。
 * 只在剩余偏低时才给数字，观察者拿不到当日基线，减法失效。
 *
 * 日后如需调整口径，可提升为后台配置项。
 */
const QUOTA_TIGHT_RATIO = 0.3;

/**
 * 今日名额概览的进程内缓存时长（5 秒）。
 * 远小于前端 90 秒轮询间隔，对用户完全无感；给匿名接口一个最低限度的抓取成本。
 */
const TODAY_QUOTA_CACHE_MS = 5 * 1000;

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
 * 北京时间（UTC+8）日期字符串 YYYY-MM-DD。
 *
 * 实现在 `src/common/date-utils.ts`（站内信的「每日上限」也要按北京日切分，
 * 两处必须同源，否则会在凌晨出现「同一时刻两个今天」）。此处**原样再导出**，
 * 是为了不动既有的 `import { beijingDateStr } from './booking.service'` 调用点——
 * 那些调用点很多，逐个改只会增加一次无收益的 diff。
 */
export { beijingDateStr };

/**
 * 组合订单级定价：整单免费（会员/每日名额）优先于人员级年龄定价。
 * 纯函数：入参为人员级年龄定价摘要，出参为最终金额、免费来源与每位人员的计费快照。
 * 优惠顺序固定：月卡会员整单免费 → 每日免费名额整单免费 → 儿童/老人人员级年龄免费。
 */
export function composeOrderPricing(
    ageSummary: AgePricingSummary,
    personCount: number,
    unitPrice: number,
    orderFreeReason: 'member' | 'dailyQuota' | null,
): {
    amount: number;
    isFree: boolean;
    freeReason: 'member' | 'dailyQuota' | 'age' | null;
    chargedPeople: number;
    ageFreePeople: number;
    passengerPricing: PassengerPricingResult[];
} {
    const ageFreePeople = ageSummary.ageFreePeople;

    if (orderFreeReason) {
        // 整单免费命中：所有人员 finalCharged=false、原因改为对应整单免费；
        // 仍保留 ageFreePeople 作为年龄资格统计
        return {
            amount: 0,
            isFree: true,
            freeReason: orderFreeReason,
            chargedPeople: 0,
            ageFreePeople,
            passengerPricing: ageSummary.passengerPricing.map((p) => ({
                ...p,
                finalCharged: false,
                pricingReason: orderFreeReason === 'member' ? 'member_order_free' : 'daily_quota_order_free',
            })),
        };
    }

    // 人员级年龄免费：收费人数 = 总人数 - 年龄免费人数；金额 = 收费人数 * 单价
    const chargedPeople = personCount - ageFreePeople;
    const amount = chargedPeople * unitPrice;
    const isFree = amount === 0;
    return {
        amount,
        isFree,
        freeReason: isFree ? 'age' : null,
        chargedPeople,
        ageFreePeople,
        passengerPricing: ageSummary.passengerPricing,
    };
}

/**
 * T1 过期扫描的执行结果
 *
 * cron 与手动触发接口共用同一个实现，所以结果要从方法里带出来：
 * 定时触发时没人看，手动触发时这是唯一的反馈来源。
 */
export interface ExpireScanResult {
    /** 命中重入锁：上一轮还没跑完，本轮什么都没做 */
    skipped: boolean;
    /** 被置为 expired 的订单数 */
    expiredCount: number;
    /** 发出（或早已存在）的「订单已过期」站内信数 */
    notifiedCount: number;
    /** 本次实际生效的静默期（分钟）。cron 恒为 120；手动触发可覆盖，便于回看出当时用了什么 */
    quietWindowMinutes: number;
    /**
     * 失败原因；null = 正常完成。
     *
     * **不在方法里向外抛**：`@Cron` 抛出去会变成 unhandled rejection，
     * 定时任务失败不该有拖垮进程的可能。手动触发接口读这个字段决定返回 200 还是 500。
     */
    error: string | null;
}

/** T2 每日提醒的执行结果（一次扫描覆盖两件事，见 runDailyReminderScan） */
export interface DailyReminderResult {
    /** 命中重入锁 */
    skipped: boolean;
    /** 当天未核销、被扫到的订单数 */
    todayPendingCount: number;
    /** 实际发出的「即将过期」提醒数 */
    remindedCount: number;
    /** 近 N 天已过期未通知、被扫到的订单数 */
    expiredPendingCount: number;
    /** 实际发出的「已过期可退款」提醒数 */
    recalledCount: number;
    /**
     * 本次实际生效的静默期（分钟），只作用于 ①。
     *
     * ②（已过期可退款）用的是**退款申请时限窗口**（`expiredAt >= now - N 天`），
     * 不是静默期——它挑的是「还能退但还没人提醒」的单，与下单时间无关。
     */
    quietWindowMinutes: number;
    /** 同 ExpireScanResult.error */
    error: string | null;
}

/**
 * 手动触发扫描任务时的可选覆盖项
 *
 * ⚠️ 只有 `POST /admin/tasks/*` 会传它。**cron 路径不传**，永远走 A 规则的默认值——
 * 这个类型的全部意义就是「让测试能跳过 2 小时干等」，不是给定时任务调参用的。
 */
export interface TaskTriggerOptions {
    /**
     * 覆盖本次扫描的静默期（毫秒）。
     *
     * `0` 是合法值 = 不设静默期：刚下单的订单也会被扫到，测「下单 → 过期 → 收通知」
     * 这条链路时必须用它，否则要干等 2 小时。生产环境慎用（用户刚下完单就会收到提醒）。
     */
    quietWindowMs?: number;
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

    // ── 今日名额概览的进程内短缓存（不写库）──
    // 该接口匿名且无限流（仓库既无 ThrottlerModule 也无 CacheModule），被脚本高频
    // 抓取会挤压 SQLite 单 writer 的写预算。5 秒 << 前端 90 秒轮询间隔，对用户完全
    // 无感，最坏情况下每 5 秒才真查一次。
    private todayQuotaCache: { key: string; value: TodayQuotaOverview; expireAt: number } | null = null;

    // ── 定时任务独立运行标记（防止自身重入）──
    private readonly taskRunning = {
        payment: false,
        close: false,
        refund: false,
        anomaly: false,
        anomalyCleanup: false,
        expire: false,   // 原 historical（T1 过期扫描），沿用同一槽位与重入保护
        dailyReminder: false, // T2 每日 22:00 提醒（当天未核销 + 近 7 天已过期未通知）
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
        // 直接注入 RefundApply 的仓库而非 RefundApplyService：审核通过要调本服务的
        // initiateRefund，若此处再依赖 RefundApplyService 就构成模块循环。
        // 与 WechatPayModule 直接注册 BookingRepository 是同一手法（见该模块注释）。
        private readonly refundApplyRepository: RefundApplyRepository,
        /**
         * 站内信（T1 ② / T2 的扫描类通知）。
         *
         * `MessageModule` 是叶子模块，`BookingModule → MessageModule` 无环。
         * 反向不成立：`MessageService` 不认识任何业务实体，订单由本服务读好后传进去。
         */
        private readonly messageService: MessageService,
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

        // 人数唯一来源为 passengers.length，拒绝 personCount 与数组长度不一致的请求
        if (createBookingDto.personCount !== createBookingDto.passengers.length) {
            throw new PassengerBusinessException(PassengerErrorCode.COUNT_MISMATCH, '预约人数与人员列表不一致');
        }

        // 车型人数上限（与 preview 共用同一校验，接口被直接调用时不可绕过）
        validatePassengerLimit(createBookingDto.passengers, createBookingDto.travelMode, createBookingDto.vehicleType);

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
            // 走 serialTransaction 排队执行：sqlite 驱动全进程共用一条连接且不允许并发事务，
            // 两个事务重叠会打坏 BEGIN/COMMIT 记账（2026-09-13 线上事故），详见 transaction-runner.ts
            const created = await serialTransaction(this.dataSource, async (entityManager) => {
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
    
                // 从 passengers[0] 同步联系人信息到兼容字段；人员计费快照使用白名单字段构造，
                // 计费字段由后端 eligibility 结果显式写入，不保留前端传入的同名字段
                const normalizedPassengers = createBookingDto.passengers.map((p, index) => {
                    const pricing = eligibility.passengerPricing[index];
                    return {
                        name: p.name,
                        phone: p.phone,
                        idCard: normalizeIdCard(p.idCard),
                        passengerType: pricing.passengerType,
                        idCardUnavailable: p.idCardUnavailable === true,
                        ageValue: pricing.ageValue,
                        ageFree: pricing.ageFree,
                        finalCharged: pricing.finalCharged,
                        pricingReason: pricing.pricingReason,
                    };
                });
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
                    // 人数唯一来源为 passengers.length，落库时不信任请求数值
                    personCount: createBookingDto.passengers.length,
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
    
                return { savedBooking, normalizedPassengers };
            });
            createdBooking = created.savedBooking;

            // 订单创建成功后，异步将乘客信息保存为常用联系人（按身份证号去重）。
            // 放在事务**提交之后**、且经 serialWrite 排同一把锁：原先在事务内用 setImmediate 触发，
            // 它会在同一条 sqlite 连接上再开一次 BEGIN/COMMIT 与父事务的 COMMIT 交错 ——
            // 线上事故的触发点之一。仍然不影响订单创建流程，保存失败也不阻断
            void serialWrite(this.dataSource, () =>
                this.userProfileRepository.upsertProfiles(createBookingDto.wechatOpenId, created.normalizedPassengers),
            ).catch((err) => {
                this.logger.warn(`自动保存常用联系人失败: ${err.message}`, err);
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
     * 每日免费名额快照（唯一口径来源）。
     *
     * preview / createBooking / 今日名额接口三处必须都走本方法，禁止再内联一份统计：
     * 口径一旦分叉就会出现「页面显示还能免费、下单却收费」这类对用户的承诺违约。
     *
     * 口径（逐字沿用既有行为）：
     *  - isFree=true 且 freeReason='dailyQuota'（显式排除 'member' 与 'age'）
     *  - 按 wechatOpenId 去重：同一用户多单只占 1 个名额
     *  - 不按 status 过滤：取消 / 退款不退还名额
     *  - 「今天」由本方法内部 beijingDateStr() 决定；targetDateStr 只用于回答
     *    「用户选的日期是不是今天」，绝不参与范围查询 —— 调用方无法让统计落到别的一天
     *
     * @param em 事务 EM 或 DataSource。createBooking 必须传事务 EM，保证判定查询与
     *           createBooking 里抢 SQLite 写锁的那条 UPDATE 处于同一事务上下文（免费名额不超卖）
     * @param paymentConfig 已读出的支付配置（避免事务内重复读配置表）
     * @param targetDateStr 用户选择的预约日期 (YYYY-MM-DD)
     * @param options.wechatOpenId 传入时额外返回该用户今日是否已享过每日免费
     */
    private async buildDailyFreeQuotaInfo(
        em: EntityManager | DataSource,
        paymentConfig: PaymentConfig,
        targetDateStr: string,
        options?: { wechatOpenId?: string },
    ): Promise<DailyFreeQuotaInfo> {
        const freeEnabled = paymentConfig.freeQuotaEnabled === true;
        const freeLimit = paymentConfig.freeQuotaLimit ?? 100;

        // 用纯日期字符串比较，避免 new Date() 产生的 ISO 字符串与 SQLite date 列不一致；
        // “今天”按北京时间（UTC+8）取，避免 UTC 日期在北京时间凌晨跨天误判
        const target = targetDateStr.length >= 10 ? targetDateStr.substring(0, 10) : targetDateStr;
        const today = beijingDateStr(); // YYYY-MM-DD，北京时间口径
        const bookingIsToday = target === today;

        // 活动未开启、或预约日期非今天：不参与每日免费。
        // 沿用既有语义：used 恒为 0、remaining 恒等于 limit（前端据此隐藏整项）
        if (!freeEnabled || !bookingIsToday) {
            return {
                enabled: freeEnabled,
                limit: freeLimit,
                used: 0,
                remaining: Math.max(0, freeLimit),
                bookingIsToday,
                userHasFreeBooking: false,
            };
        }

        const bookingRepo = em.getRepository(Booking);
        // SQLite date 列只存日期，用纯日期字符串做范围查询（>= today AND <= today 即当天）
        const dayStart = today;
        const nextDay = today;

        // 当日已用免费名额（去重用户数，仅算 dailyQuota，不含 member / age）。
        // 注意：刻意不按 status 过滤 —— 取消 / 退款不退还名额，与下单时的判定严格一致
        const freeCountResult = await bookingRepo
            .createQueryBuilder('booking')
            .select('COUNT(DISTINCT booking.wechatOpenId)', 'count')
            .where('booking.isFree = :isFree', { isFree: true })
            .andWhere('booking.freeReason = :reason', { reason: 'dailyQuota' })
            .andWhere('booking.bookingDate >= :dayStart', { dayStart })
            .andWhere('booking.bookingDate <= :nextDay', { nextDay })
            .getRawOne();
        const used = parseInt(freeCountResult?.count || '0', 10);

        // 当前用户今日是否已享过每日免费（同样仅算 dailyQuota）
        let userHasFreeBooking = false;
        if (options?.wechatOpenId) {
            const userFreeCount = await bookingRepo
                .createQueryBuilder('booking')
                .where('booking.wechatOpenId = :openid', { openid: options.wechatOpenId })
                .andWhere('booking.isFree = :isFree', { isFree: true })
                .andWhere('booking.freeReason = :reason', { reason: 'dailyQuota' })
                .andWhere('booking.bookingDate >= :dayStart', { dayStart })
                .andWhere('booking.bookingDate <= :nextDay', { nextDay })
                .getCount();
            userHasFreeBooking = userFreeCount > 0;
        }

        return {
            enabled: true,
            limit: freeLimit,
            used,
            remaining: Math.max(0, freeLimit - used),
            bookingIsToday,
            userHasFreeBooking,
        };
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

        // 0. 统一人员业务校验与年龄定价（preview 与 create 共用，先于任何数据库查询；
        //    create 事务内的纯函数异常会使事务干净回滚）
        validatePassengerBusinessRules(passengers, bookingDate);
        const agePricing = calculateAgePricing(passengers, bookingDate);
        // 车型人数上限（按 passengers.length，不信任 personCount）
        validatePassengerLimit(passengers, travelMode, vehicleType);

        // 1. 读取支付配置（含每日免费名额配置）
        const config = await configRepo.findOne({ where: { configId: 'system_config' } });
        const paymentConfig = config?.paymentConfig ?? { paymentAmount: 0 };
        const unitPrice = paymentConfig.paymentAmount ?? 0;
        const freeEnabled = paymentConfig.freeQuotaEnabled === true;
        const freeLimit = paymentConfig.freeQuotaLimit ?? 100;

        const personCount = passengers.length;

        // 2. 会员判定：仅「自驾 + 摩托车」才查会员，按身份证+车牌双匹配
        //    身份证：任一乘客身份证命中会员登记身份证
        //    车牌：下单车牌命中会员登记车牌（多个，分号分隔）其一
        const isMotorcycle = travelMode === TravelMode.SELF_DRIVING && vehicleType === VehicleType.WHEEL_MOTORCYCLE;
        let activeMember: Awaited<ReturnType<MemberService['getActiveMemberByIdCard']>> = null;
        let memberIdCardMatched = false;
        if (isMotorcycle) {
            // 遍历乘客身份证，找到第一个命中的有效会员；
            // 无身份证（暂时无法提供）人员不参与会员匹配，避免把空值传给会员服务
            for (const p of passengers) {
                if (!p.idCard) continue;
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

        // 3. 每日免费名额与「是否今天」（口径唯一来源，见 buildDailyFreeQuotaInfo 注释）。
        //    同时产出 bookingIsToday，避免「是否今天」这个判断在本文件里出现两次而悄悄分叉
        const freeQuotaInfo = await this.buildDailyFreeQuotaInfo(em, paymentConfig, bookingDate, {
            wechatOpenId,
        });
        const { bookingIsToday, userHasFreeBooking } = freeQuotaInfo;
        const quotaUsed = freeQuotaInfo.used;

        // 4. 会员免费命中：摩托车 + 身份证命中 + 车牌命中
        if (isMotorcycle && activeMember && memberIdCardMatched) {
            const memberPlates = activeMember.licensePlates
                ? activeMember.licensePlates.split(';').map((s) => s.toUpperCase().trim()).filter((s) => s.length > 0)
                : [];
            const inputPlate = (licensePlate ?? '').toUpperCase().trim();
            const plateMatched = inputPlate.length > 0 && memberPlates.includes(inputPlate);
            if (plateMatched) {
                const composed = composeOrderPricing(agePricing, personCount, unitPrice, 'member');
                return {
                    isFree: composed.isFree,
                    freeReason: composed.freeReason,
                    reason: null,
                    amount: composed.amount,
                    unitPrice,
                    personCount,
                    ageFreePeople: composed.ageFreePeople,
                    chargedPeople: composed.chargedPeople,
                    passengerPricing: composed.passengerPricing,
                    memberInfo,
                    freeQuotaInfo,
                };
            }
        }

        // 5. 每日免费名额命中（仅会员未命中时）
        if (freeEnabled && bookingIsToday && !userHasFreeBooking && quotaUsed < freeLimit) {
            const composed = composeOrderPricing(agePricing, personCount, unitPrice, 'dailyQuota');
            return {
                isFree: composed.isFree,
                freeReason: composed.freeReason,
                reason: null,
                amount: composed.amount,
                unitPrice,
                personCount,
                ageFreePeople: composed.ageFreePeople,
                chargedPeople: composed.chargedPeople,
                passengerPricing: composed.passengerPricing,
                memberInfo,
                freeQuotaInfo,
            };
        }

        // 6. 收费分支：按优先级定 reason
        //    摩托车且身份证命中会员但车牌未命中 → member_plate_not_matched（确为会员，仅车牌未登记）
        //    摩托车但未找到任何会员记录（非会员）→ not_member（会员免费不适用，前端不展示原因文案）
        //    每日免费活动开启但名额用完/已享过/非今日 → daily_quota_* / not_today
        //    每日免费活动未开启（关闭）→ no_free_activity（活动隐藏，不向用户暴露免费相关文案）
        let reason: FreeEligibilityResult['reason'];
        if (isMotorcycle && activeMember && memberIdCardMatched) {
            // 身份证命中会员但车牌未命中（走到这里说明车牌比对失败）
            reason = 'member_plate_not_matched';
        } else if (isMotorcycle && !activeMember) {
            // 摩托车但未找到任何有效会员记录：会员免费不适用，按正常收费且不展示原因。
            // 不可报 member_idcard_not_matched —— activeMember 与 memberIdCardMatched 同生共死，
            // 真正“身份证与会员记录不一致”的场景在上面的循环里不可达，
            // 那样写只会把「从来没注册过会员」误报成「身份证与会员记录不一致」。
            reason = 'not_member';
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

        const composed = composeOrderPricing(agePricing, personCount, unitPrice, null);
        return {
            isFree: composed.isFree,
            freeReason: composed.freeReason,
            reason,
            amount: composed.amount,
            unitPrice,
            personCount,
            ageFreePeople: composed.ageFreePeople,
            chargedPeople: composed.chargedPeople,
            passengerPricing: composed.passengerPricing,
            memberInfo,
            freeQuotaInfo,
        };
    }

    /**
     * 更新预约订单
     * @param bookingId 订单ID
     * @param updateBookingDto 更新数据对象
     * @returns 更新后的订单
     */
    /**
     * 用户主动取消「待支付」订单。
     *
     * 归属校验 → 状态判定 → 条件更新（markCancelledByUser 原子防并发）。
     * 与旧实现的关键差异：旧路径是 `PUT /bookings/:id` 的裸读-改-写，
     * 既无归属校验也无状态守卫，任何人都能按订单号把别人的订单置为 cancelled。
     */
    async cancelBooking(bookingId: string, openid: string) {
        const booking = await this.bookingRepository.getBookingById(bookingId);
        // 先校验归属，再谈状态：不向非本人泄露订单当前处于什么状态
        if (booking.wechatOpenId !== openid) {
            throw new BadRequestException('无权操作该订单');
        }

        // PAYING 可能已在微信侧建单，钱随时可能落到账上，不能在此杀掉，
        // 否则会出现「已取消却收到钱」。交给已有的超时关单对账收敛。
        // 详见 markCancelledByUser 的注释。
        if (booking.status === BookingStatus.PENDING && booking.paymentStatus === PaymentStatus.PAYING) {
            throw new BookingException(BookingErrorCode.ORDER_PAYMENT_IN_PROGRESS, '支付处理中，请稍后重试');
        }

        const affected = await this.bookingRepository.markCancelledByUser(bookingId);
        if (affected === 0) {
            // 条件不满足：并发下已被支付回调/关单对账推进，或本就不是待支付订单
            throw new BookingException(BookingErrorCode.ORDER_CANNOT_CANCEL, '订单状态已变化，无法取消');
        }

        return await this.bookingRepository.getBookingById(bookingId);
    }

    /**
     * 根据订单ID查询订单（用户侧，含归属校验）
     *
     * openid 为必填：旧签名开了 `openid?: string`，传空即静默跳过归属校验，
     * 任何人拿到订单号就能读到姓名/手机号/身份证。改为必填由类型系统兜住。
     * 管理端读订单走 getBookingByIdForAdmin。
     *
     * @param bookingId 订单ID
     * @param openid 当前登录用户 openid
     * @returns 订单详情
     */
    async getBookingById(bookingId: string, openid: string) {
        const booking = await this.bookingRepository.getBookingById(bookingId);
        if (booking.wechatOpenId !== openid) {
            throw new BadRequestException('无权访问该订单');
        }
        return booking;
    }

    /**
     * 读取订单（**管理端专用，不做归属校验**）
     *
     * 与 `getBookingById` 是两个方法而不是同一个方法的可选参数：归属校验一旦
     * 变成「可传入参数关掉」，任何一次调用点写错都在静默降级为越权读取。
     * 拆开后，管理端的越权面就是本方法本身，grep 一下就能审完。
     *
     * 仅供已挂 `AdminAuthGuard` 的控制器调用（退款审核详情需要展示订单快照）。
     *
     * @param bookingId 订单ID
     * @returns 订单详情
     */
    async getBookingByIdForAdmin(bookingId: string) {
        return await this.bookingRepository.getBookingById(bookingId);
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
     * 给订单挂上「核销人姓名」（`verifiedByName`）
     *
     * `bookings.verifiedBy` 落的是核销员的 openid，直接展示是一串 28 位随机字符，
     * 解析成 `admin_applications.name` 才对人有意义。
     *
     * 【解析不到为什么给 null，而不是回落到 openid】这一层只管「能不能解析出名字」，
     * 展示成什么由调用方定：后台要能追责（回落显示 openid），小程序端给游客看
     * openid 则毫无意义（回落到不显示）。策略塞在这里，两个端就没得选了。
     *
     * 【为什么只对 completed 发起查询】其余状态 `verifiedBy` 必为 null。
     * 小程序详情会被 5 秒轮询、后台列表一页最多 100 行，白查是常态开销。
     */
    async attachVerifierNames<T extends { status?: BookingStatus; verifiedBy?: string | null }>(
        rows: T[],
    ): Promise<(T & { verifiedByName: string | null })[]> {
        const openids = rows
            .filter((row) => row.status === BookingStatus.COMPLETED && row.verifiedBy)
            .map((row) => row.verifiedBy as string);

        if (openids.length === 0) {
            return rows.map((row) => ({ ...row, verifiedByName: null }));
        }

        // 姓名是**装饰**，不是订单数据本身。这一步挂掉不能让整页订单打不开——
        // 后台订单列表是运营的主入口，为了一个「谁核的」把列表整个 500 掉不值当。
        // 失败就回落成 null，前端退到显示 openid：信息少一点，页面还在。
        const names = await this.adminApplicationRepository
            .findApprovedNamesByOpenids(openids)
            .catch((error) => {
                this.logger.error(
                    `核销人姓名解析失败（不影响订单列表）: ${openids.length} 个 openid`,
                    error instanceof Error ? error.stack : String(error),
                );
                return new Map<string, string>();
            });

        return rows.map((row) => ({
            ...row,
            verifiedByName: (row.verifiedBy && names.get(row.verifiedBy)) || null,
        }));
    }

    /**
     * 管理员查询订单列表（无 openid 限制）
     */
    async getBookingsForAdmin(query: { bookingDate?: string; createdStart?: string; createdEnd?: string; status?: BookingStatus[]; keyword?: string; page?: number; pageSize?: number }) {
        const result = await this.bookingRepository.getBookingsForAdmin(query);
        // 核销人姓名随列表一起下发；订单详情接口另有自己的接入点
        return { ...result, bookings: await this.attachVerifierNames(result.bookings) };
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
     * 今日名额概览（GET /bookings/today-quota 的唯一数据来源）
     *
     * 【安全边界】响应字段的约束见 dto/today-quota.dto.ts 顶部说明。要点：
     * 「今天」由服务端 beijingDateStr() 决定，本方法签名里没有任何日期入参，
     * 因此不存在被拼参数回捞历史序列、反推每日总量的可能。
     */
    async getTodayQuotaOverview(): Promise<TodayQuotaOverview> {
        const today = beijingDateStr(); // 固定今天，不接受外部日期

        // 进程内短缓存：本接口匿名且无限流，防止被高频抓取挤压 SQLite 写预算
        const cached = this.todayQuotaCache;
        if (cached && cached.key === today && cached.expireAt > Date.now()) {
            return cached.value;
        }

        // 容量：与 createBooking 的容量校验完全同一口径。
        // morningMaxPeople 即全天总限额（上下午概念已废弃），但历史数据里 afternoon 桶仍有
        // 记录，必须两桶相加，否则会低估已约人数、高估剩余名额
        const timeSlotLimit = await this.systemConfigService.getTimeSlotLimit();
        const maxPeople = timeSlotLimit.morningMaxPeople;
        const stats = await this.bookingRepository.getBookingStatsByDate(today);
        const currentPeople = stats.morning.totalPeople + stats.afternoon.totalPeople;
        const remaining = Math.max(0, maxPeople - currentPeople);

        // 免费名额：与 preview / 下单共用同一私有方法（不传 openid，省掉一次用户维度查询）
        const paymentConfig = await this.systemConfigService.getPaymentConfig();
        const freeQuota = await this.buildDailyFreeQuotaInfo(this.dataSource, paymentConfig, today);

        const overview: TodayQuotaOverview = {
            date: today,
            // 【禁止新增字段】total / maxPeople / currentPeople / bookedPeople / bookingCount：
            // 「已约人数 = 总限额 − 剩余」，返回总限额等于把已约人数直接送出去。
            // level='plenty' 时刻意不带 remaining —— 若一直下发精确剩余，任何人从当天 00:00
            // 开始轮询、取首尾差值就等于当天的已约人数（见 QUOTA_TIGHT_RATIO 注释）
            capacity: remaining <= 0
                ? { level: 'full' }
                : remaining <= maxPeople * QUOTA_TIGHT_RATIO
                    ? { level: 'limited', remaining }
                    : { level: 'plenty' },
            freeQuota: {
                enabled: freeQuota.enabled,
                limit: freeQuota.limit,
                remaining: freeQuota.remaining,
            },
        };

        this.todayQuotaCache = {
            key: today,
            value: overview,
            expireAt: Date.now() + TODAY_QUOTA_CACHE_MS,
        };
        return overview;
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
     *
     * **已过期订单的自助入口在此关闭**（方案 §1.4 Q1）：`expired` 的资金出口只有
     * 「用户提交申请 → 管理员审核 → 通过后由服务端带 asAdmin 调用本方法」这一条。
     * 必须在此拦截，而不是只靠前端隐藏按钮——隐藏只是体验，拦截才是安全边界。
     *
     * ⚠️ 与阶段 3 的先后顺序（硬约束）：`markRefundStarting` 一旦放开
     * `status IN ('confirmed','expired')`，仓库层对过期单的 status 守卫就恒真了，
     * **本方法这道判断会成为过期订单唯一的自助退款拦截面**。两者必须同一次发布，
     * 且本判断先落地——顺序颠倒会出现「审核制形同虚设」的窗口。
     *
     * @param bookingId 订单ID
     * @param openid 申请人 openid。**审核路径（asAdmin=true）下本参数被忽略**——
     *        该路径由服务端内部发起，归属校验跳过（见方法内注释）
     * @param options.asAdmin 审核通过后的服务端调用路径（阶段 3 起启用）；
     *        为 true 时跳过归属校验并放行 `expired`。默认 false＝用户自助退款，
     *        既校验归属、也拒绝过期订单
     * @param options.outRefundNo 审核路径下由审核服务按申请序号算出的退款单号
     *        （`buildOutRefundNo`：首次 `RF{bookingId}`，二次 `RF{bookingId}-2`…）。
     *        传入时不走 `booking.outRefundNo ?? 'RF'+bookingId`——那条幂等规则是为
     *        「自助退款重试单号不变」设计的，而审核路径下**同一次退款成功的重试**
     *        由 `prepareApproval` 复用申请单上已落库的 `outRefundNo` 保证，
     *        不能退化成「永远用 RF{bookingId}」——否则用户第二次申请退款会命中
     *        微信对同一个 out_refund_no 的幂等返回（同一单已退过），资金永远退不出去。
     * @returns 退款结果
     */
    async initiateRefund(
        bookingId: string,
        openid: string,
        options?: { asAdmin?: boolean; outRefundNo?: string },
    ) {
        const booking = await this.bookingRepository.getBookingById(bookingId);
        if (!booking) {
            throw new BadRequestException('订单不存在');
        }

        // 归属校验：**审核路径（asAdmin）必须跳过**。
        // 该路径的调用者是服务端自己（AdminService.approveRefundApply），操作者是管理员、
        // 不是下单人，它手里根本没有下单人的 openid（调用时传空串）。
        // ⚠️ 这一条曾经漏掉：`asAdmin` 只放行了下面那道 `expired` 拦截，归属校验仍是无条件的，
        // 于是「审核通过」永远抛「无权操作该订单」——单据已落 approved、钱一分没动，
        // 且因为状态已不是 pending 而无法重试。回归锁在 `refund-approve-chain.spec.ts`
        // （链路级：会真的把 refundStatus 走到 refunding）。
        // 用户自助路径（`POST /bookings/:id/refund`）不带 asAdmin，校验原样保留。
        if (!options?.asAdmin && booking.wechatOpenId !== openid) {
            throw new BadRequestException('无权操作该订单');
        }
        if (booking.isFree) {
            throw new BadRequestException('免费预约无需退款');
        }
        if (booking.status === BookingStatus.COMPLETED) {
            throw new BadRequestException('订单已完成，无法退款');
        }
        // 已过期订单必须走「申请 → 审核」，不允许自助退款（Q1）。
        // 过期订单 status 为 expired，上面那条 COMPLETED 判断不会命中，
        // 而这条是它与「用户点旧入口直接退款」之间唯一的拦截面——见方法注释的时序说明。
        if (booking.status === BookingStatus.EXPIRED && !options?.asAdmin) {
            throw new BadRequestException('订单已过期，退款需经管理员审核，请在小程序订单详情页提交退款申请');
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

        // 幂等保护：固定退款单号（不含时间戳），保证重试时单号不变，避免重复退款。
        // 审核路径（options.outRefundNo）由审核服务按申请序号给号，见方法注释。
        const outRefundNo = options?.outRefundNo ?? booking.outRefundNo ?? `RF${booking.bookingId}`;

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
     * T1 过期扫描：每小时（13 分，沿用原 `runHistoricalBookingUpdate` 的槽位与重入保护），
     * 不调用微信，批量条件 UPDATE。
     *
     * **取代原 `runHistoricalBookingUpdate`**。原实现把「预约日已过且未核销」的订单置为
     * `completed`，使「没来」与「来过」在数据上再也无法区分；现在改为置 `expired`。
     * 由此 `completed` 语义收窄为「已核销」，唯一写入方是 `markVerified`。
     *
     * 频率说明（§4.2.2）：过期判定是 `bookingDate < 今天`，一天只在跨零点时变化一次，
     * 每小时跑已是超额覆盖，不改频率。
     *
     * 「今天」固定取**北京时间**，不用服务器本地日期：
     * 原实现用 `new Date()` 的服务器本地年月日，服务器若跑 UTC，过期边界会比北京零点
     * 晚最多 8 小时（当天凌晨的订单要多挂 8 小时才下沉）。
     *
     * ⚠️ 边界以**日期字符串**交给仓库（`beijingDateStr()` 的返回值），不构造 `Date`。
     * 这里曾写 `new Date(\`${beijingDateStr()}T00:00:00\`)` 并注释"TypeORM 对 date 列按
     * 本地分量格式化，故时区无关"——**该判断是错的**：`where` 里的 `Date` 参数由 TypeORM 走
     * `mixedDateToUtcDatetimeString`，绑定成 **UTC 分量**的 `'2026-09-13 00:00:00.000'`；
     * 与纯 `'2026-09-13'` 列做字符串比较时 `'2026-09-13' < '2026-09-13 00:00:00.000'`
     * 为真，于是「< 今天」退化成「≤ 今天」，**UTC 服务器下当天订单会被误置为 expired**。
     * 详见 `markExpired` 的注释与 `implementation-todo.md` 说明 23（含实测绑定值）。
     *
     * 顺序：先状态流转，再发通知（§4.2.3 步骤①②）。两步**完全解耦**：
     *   ① 只改状态，失败了下轮重跑（`WHERE status='confirmed'` 已不匹配的不会重复处理）；
     *   ② 只发通知，靠 `expireNotifiedAt IS NULL` 标记位补发。
     * 任一步骤失败都不会造成永久漏发——这是 v1「用扫描窗口挑待通知订单」的替代方案。
     *
     * @param options 只由手动触发接口传入。cron 不传，静默期永远是 A 规则的 2 小时
     */
    @Cron('0 13 * * * *', { timeZone: 'Asia/Shanghai' })
    async runExpireScan(options: TaskTriggerOptions = {}): Promise<ExpireScanResult> {
        const quietWindowMs = this.resolveQuietWindow(options.quietWindowMs);
        const quietWindowMinutes = Math.round(quietWindowMs / 60000);
        if (this.taskRunning.expire) {
            return { skipped: true, expiredCount: 0, notifiedCount: 0, quietWindowMinutes, error: null };
        }
        this.taskRunning.expire = true;
        try {
            const now = Date.now();
            // 步骤①：状态流转
            const affected = await this.bookingRepository.markExpired(beijingDateStr(), now);
            // 步骤②：发通知（按标记位捞，跑几次都安全）
            const notified = await this.notifyExpiredBookings(now, quietWindowMs);

            this.logTask('expire', AppLogLevel.INFO, '完成', {
                task: 'expire',
                expiredCount: affected,
                notifiedCount: notified,
                quietWindowMinutes,
            });
            return { skipped: false, expiredCount: affected, notifiedCount: notified, quietWindowMinutes, error: null };
        } catch (error) {
            this.logger.error('过期扫描任务失败', error);
            const message = (error as Error).message;
            this.logTask('expire', AppLogLevel.ERROR, '失败', { task: 'expire', error: message });
            return { skipped: false, expiredCount: 0, notifiedCount: 0, quietWindowMinutes, error: message };
        } finally {
            this.taskRunning.expire = false;
        }
    }

    /**
     * 解析本次扫描的静默期
     *
     * 不传 → A 规则的默认值（`MESSAGE_QUIET_WINDOW_MS`）。只有手动触发接口会传。
     *
     * 越界值在这里钳制而不是抛错：DTO 已经拦过一道（400），这里是防「绕过 HTTP 直接调
     * service」的第二道。下界 0 是**合法值**（不设静默期，测试刚下的单要用），
     * 上界 24 小时——再大等于把通知整体静默掉，那是关功能不是调参。
     */
    private resolveQuietWindow(overrideMs?: number): number {
        if (overrideMs === undefined || overrideMs === null) return MESSAGE_QUIET_WINDOW_MS;
        const n = Number(overrideMs);
        if (!Number.isFinite(n)) return MESSAGE_QUIET_WINDOW_MS;
        return Math.min(Math.max(0, Math.floor(n)), MESSAGE_QUIET_WINDOW_MAX_MS);
    }

    /**
     * T2 每日 22:00 提醒（§4.2.4，一次扫描覆盖两件事）
     *
     *   ① 当天预约、仍未核销的 → 「订单即将过期，请尽快核销」
     *      `dedupeKey = ORDER_EXPIRE_REMINDER:{bookingId}`，**不写任何标记位**：
     *      这张订单当天只会被扫到一次（`bookingDate = 今天` 在次日即不成立），
     *      去重键只是为了防「同一轮里被重复处理」，不需要 `expireNotifiedAt`。
     *   ② 近 7 天已过期、从未通知、且未提交退款申请的 → 「订单已过期，可申请退款」
     *      `dedupeKey = ORDER_EXPIRED:{bookingId}`，**发送后写 `expireNotifiedAt`**。
     *      它兜底三件事（§4.2.4）：T1 的漏发、被 A 规则挡掉的人（23:50 下单、
     *      00:13 被翻成过期的用户，此刻 `createdAt` 早已满足 2 小时）、以及唤回
     *      「过期了但不知道自己能退款」的用户。7 天窗口与退款申请时限**同源**
     *      （`getRefundApplyDeadlineDays()`），保证提醒只落在「还能退」的区间内。
     *
     * 22:00 而不是更晚：当天核销的提醒必须在**当天还能核销**的时候送达，
     * 22:00 留出 2 小时余量；再晚用户已入睡，推送等于白发。
     *
     * ⚠️ 与 T1 用的是**同一个 dedupeKey**（`ORDER_EXPIRED:{bookingId}`），
     * 这是刻意的：两条路径谁先到谁生效，另一条被去重拦下、照样写标记位，
     * 用户不会收到两条「已过期」。若两处 key 不一致，就会轰炸。
     *
     * @param options 只由手动触发接口传入，覆盖的静默期**只作用于 ①**（② 用的是退款时限窗口）
     */
    @Cron('0 0 22 * * *', { timeZone: 'Asia/Shanghai' })
    async runDailyReminderScan(options: TaskTriggerOptions = {}): Promise<DailyReminderResult> {
        const quietWindowMs = this.resolveQuietWindow(options.quietWindowMs);
        const quietWindowMinutes = Math.round(quietWindowMs / 60000);
        if (this.taskRunning.dailyReminder) {
            return {
                skipped: true,
                todayPendingCount: 0,
                remindedCount: 0,
                expiredPendingCount: 0,
                recalledCount: 0,
                quietWindowMinutes,
                error: null,
            };
        }
        this.taskRunning.dailyReminder = true;
        try {
            const now = Date.now();

            // ① 当天未核销 → 提醒核销
            const todayPending = await this.bookingRepository.findTodayUnverified(
                beijingDateStr(),
                MESSAGE_SCAN_BATCH_LIMIT,
                now,
                quietWindowMs,
            );
            let reminded = 0;
            for (const booking of todayPending) {
                // 只计真正发出去的：被每日配额挡下的也在这批里，
                // 算进去会让日志和手动触发看到的数字变成「尝试数」而不是「发出数」
                if (await this.notifyQuietly(MessageType.ORDER_EXPIRE_REMINDER, booking, now)) reminded++;
            }

            // ② 近 N 天已过期未通知 → 提醒可退款（兜底 + 唤回）
            const deadlineDays = this.systemConfigService.getRefundApplyDeadlineDays();
            const expiredPending = await this.bookingRepository.findExpiredForRefundReminder(
                MESSAGE_SCAN_BATCH_LIMIT,
                now,
                deadlineDays * 24 * 60 * 60 * 1000,
            );
            let recalled = 0;
            for (const booking of expiredPending) {
                if (await this.notifyExpiredBooking(booking, now)) recalled++;
            }

            this.logTask('daily-reminder', AppLogLevel.INFO, '完成', {
                task: 'daily-reminder',
                todayPendingCount: todayPending.length,
                remindedCount: reminded,
                expiredPendingCount: expiredPending.length,
                recalledCount: recalled,
                quietWindowMinutes,
            });
            return {
                skipped: false,
                todayPendingCount: todayPending.length,
                remindedCount: reminded,
                expiredPendingCount: expiredPending.length,
                recalledCount: recalled,
                quietWindowMinutes,
                error: null,
            };
        } catch (error) {
            this.logger.error('每日提醒任务失败', error);
            const message = (error as Error).message;
            this.logTask('daily-reminder', AppLogLevel.ERROR, '失败', {
                task: 'daily-reminder',
                error: message,
            });
            return {
                skipped: false,
                todayPendingCount: 0,
                remindedCount: 0,
                expiredPendingCount: 0,
                recalledCount: 0,
                quietWindowMinutes,
                error: message,
            };
        } finally {
            this.taskRunning.dailyReminder = false;
        }
    }

    /**
     * T1 步骤②的实现：把「已过期但未通知」的订单逐条发出去（§4.2.3）
     *
     * @returns 已发出（或早已存在）的条数
     */
    private async notifyExpiredBookings(now: number, quietWindowMs: number): Promise<number> {
        const pending = await this.bookingRepository.findExpiredNotNotified(
            MESSAGE_SCAN_BATCH_LIMIT,
            now,
            quietWindowMs,
        );
        let notified = 0;
        for (const booking of pending) {
            if (await this.notifyExpiredBooking(booking, now)) notified++;
        }
        return notified;
    }

    /**
     * 发一条「订单已过期，可申请退款」，并按结果决定是否写标记位
     *
     * **只有 `sent=true` 才写 `expireNotifiedAt`**（含「早已存在」——那说明
     * 上一轮发过而标记位没写上，两条路径共用同一个 dedupeKey，写标记位是正确收尾）。
     * 被每日配额挡下时 `sent=false`，**不写**：下轮继续扫到，明日额度重置后自然补发。
     * 若不写，`ORDER_EXPIRED` 会在同一用户身上一轮一轮地丢——这是「防打扰」与
     * 「不漏发」之间的正确一侧。
     *
     * 申请截止日走 `resolveApplyDeadlineStr`（与退款入口**同一个公式**）：
     * 站内信里写的日期必须和接口判定的一致，否则用户会按信里的日期卡点来申请却被拒。
     */
    private async notifyExpiredBooking(booking: Booking, now: number): Promise<boolean> {
        const applyDeadline = resolveApplyDeadlineStr(
            booking.expiredAt,
            this.systemConfigService.getRefundApplyDeadlineDays(),
        );
        try {
            const sent = await this.messageService.sendOrderExpired(
                { bookingId: booking.bookingId, wechatOpenId: booking.wechatOpenId },
                applyDeadline,
                new Date(now),
            );
            if (sent) {
                await this.bookingRepository.markExpireNotified(booking.bookingId, now);
            }
            return sent;
        } catch (error) {
            // 单条失败不中断整批：这批是「历史积压」形态，一条卡住不应让后面全部推迟一小时。
            // 该条的标记位没写，下轮还会被扫到。
            this.logger.error(
                `过期通知发送失败: bookingId=${booking.bookingId}`,
                error instanceof Error ? error.stack : String(error),
            );
            return false;
        }
    }

    /**
     * T2 ① 的发送（提醒核销）
     *
     * 不写标记位（理由见 `runDailyReminderScan`），因此也不需要处理配额——
     * 被挡下就挡下了，次日该订单若仍未核销会转成 T1/T2 ② 的「已过期可退款」，
     * 不存在永久漏发。
     */
    private async notifyQuietly(msgType: MessageType, booking: Booking, now: number): Promise<boolean> {
        try {
            const result = await this.messageService.send(
                msgType,
                { userId: booking.wechatOpenId, bookingId: booking.bookingId },
                new Date(now),
            );
            // sent=false 只有一种情况：撞上该用户的每日系统消息上限（§4.4 防打扰）。
            // 如实返回，调用方的计数才是「发出数」而不是「尝试数」
            return result.sent;
        } catch (error) {
            this.logger.error(
                `每日提醒发送失败: msgType=${msgType}, bookingId=${booking.bookingId}`,
                error instanceof Error ? error.stack : String(error),
            );
            return false;
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
     * 把资金终态镜像到退款申请单（§4.3.3 改动 3）
     *
     * 三条路径都会收敛同一笔退款：微信回调、15 分钟对账 Cron、异常通道重试。
     * 这里做的是「申请单跟随资金结果」，**不参与任何状态决策**——`markSettled`
     * 内部限定 `WHERE status='approved'`，已是终态时 affected=0，重复调用无害。
     *
     * 非申请单发起的退款（用户自助、管理员直接退款）反查不到申请单，静默返回，
     * 这是正常路径而非异常（见 RefundApplyRepository.findByOutRefundNo 的注释）。
     *
     * @param outRefundNo 本次退款的商户退款单号
     * @param success 资金是否到账
     */
    private async mirrorRefundSettlement(outRefundNo: string, success: boolean): Promise<void> {
        const apply = await this.refundApplyRepository.findByOutRefundNo(outRefundNo);
        if (!apply) return;
        const affected = await this.refundApplyRepository.markSettled(apply.applyNo, success);
        // 到账通知：只在**本次真的推动了状态**时发（三条收敛路径并发时只有先到的拿到 1）。
        // 不放在 `RefundApplyService.syncSettledByOutRefundNo` 里，是因为本方法（以及
        // WechatPayService 的同名方法）**刻意不经过那个服务**——写在那边会让真实回调
        // 路径上的通知永远发不出去。方法自身不抛异常，故这里不套 try/catch。
        if (affected > 0) await this.messageService.notifyRefundSettled(apply, success);
    }

    /**
     * 退款对账结果应用
     */
    private async applyRefundReconcileResult(booking: Booking, result: any) {
        const now = Date.now();
        switch (result.state) {
            case 'SUCCESS':
                await this.bookingRepository.markRefundSucceeded(booking.bookingId, booking.outRefundNo, new Date());
                await this.mirrorRefundSettlement(booking.outRefundNo, true);
                await this.bookingRepository.resolveAnomaly(booking.bookingId, AnomalyType.REFUND_QUERY_REPEATED_FAILURE, '退款对账确认成功', now);
                break;
            case 'CLOSED':
            case 'NOT_EXIST':
                // 微信明确终态失败或退款单不存在：标记失败，清空调度字段
                await this.bookingRepository.markRefundFailed(booking.bookingId, booking.outRefundNo);
                await this.mirrorRefundSettlement(booking.outRefundNo, false);
                await this.bookingRepository.resolveAnomaly(booking.bookingId, AnomalyType.REFUND_QUERY_REPEATED_FAILURE, '退款对账确认终态失败', now);
                break;
            case 'PROCESSING':
                // 仍在处理中：15 分钟后再查
                await this.bookingRepository.rescheduleRefundCheck(booking.bookingId, booking.outRefundNo, now + 15 * 60 * 1000, now);
                break;
            case 'ABNORMAL':
            case 'UNKNOWN':
            default:
                // 临时错误 / 微信退款异常：attempts 加一，连续三次后升级异常。
                //
                // ⚠️ `ABNORMAL` 必须留在**这一侧**，不能跟 CLOSED 一起判终态失败：
                // 微信的「退款异常」常见原因是商户可用余额不足，补足后微信侧仍可能完成这笔退款。
                // 判成失败会让用户重新申请 → 换号重发（`RF{id}-2`）→ 第一笔后来成功就是**重复退款**。
                // 旧实现靠固定单号 `RF{bookingId}` + 微信幂等天然不可能退两次，换号之后这个保护没了，
                // 所以只能靠「不判终态」来兜。代价是异常单可能多挂一会儿，由人工/后续对账收敛。
                await this.bookingRepository.markRefundResultUnknown(booking.bookingId, booking.outRefundNo, result.errorCode ?? 'QUERY_REFUND_UNKNOWN', now);
                const fresh = await this.bookingRepository.getBookingById(booking.bookingId);
                if (fresh.refundStatus === RefundStatus.REFUNDING && fresh.reconcileAttempts >= 3) {
                    await this.bookingRepository.escalateReconciliationAnomaly(
                        fresh.bookingId,
                        AnomalyType.REFUND_QUERY_REPEATED_FAILURE,
                        result.errorCode ?? 'QUERY_REFUND_UNKNOWN',
                        result.state === 'ABNORMAL'
                            ? '微信退款异常（非终态）：常见原因是商户可用余额不足，需人工核查商户账户'
                            : '退款查询连续失败',
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
                await this.mirrorRefundSettlement(booking.outRefundNo, true);
                await this.bookingRepository.resolveAnomaly(booking.bookingId, anomaly.type, action.resolution, now);
                return;
            case 'refundFailed':
                await this.bookingRepository.markRefundFailed(booking.bookingId, booking.outRefundNo);
                await this.mirrorRefundSettlement(booking.outRefundNo, false);
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
     * 将 CONFIRMED 订单标记为 COMPLETED，并写入核销留痕（verifiedAt / verifiedBy）
     *
     * 互斥保证：真正的状态流转由 `markVerified` 的条件更新完成（WHERE status='confirmed'）；
     * 下方的前置校验只为给出友好错误文案，**不是**并发保护。
     * 这样核销与 T1 的 `markExpired` 严格互斥——若核销晚于 T1，affected=0，
     * 不会把已过期订单写回 completed（那等于一次绕过审核的补核销，Q2 不允许）。
     *
     * @param bookingId 订单ID
     * @param openid 操作者 openid（核销员，写入 verifiedBy 留痕）
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

        const affected = await this.bookingRepository.markVerified(bookingId, openid, Date.now());
        if (affected === 0) {
            // 读到写之间状态被其他流程推进（典型：T1 已把订单翻成 expired，或并发重复核销）
            const fresh = await this.bookingRepository.getBookingById(bookingId);
            this.loggingService.write({
                source: AppLogSource.BACKEND,
                level: AppLogLevel.WARN,
                category: AppLogCategory.BOOKING,
                message: '预约核验失败',
                route: `/bookings/${bookingId}/verify`,
                context: { bookingId, currentStatus: fresh.status, reason: 'conditional-update-missed' },
            });
            throw new BadRequestException(`订单状态不可核验，当前状态：${fresh.status}`);
        }

        // 记录点：核验成功（含核销员，便于核销故障统计与追责）
        this.loggingService.write({
            source: AppLogSource.BACKEND,
            level: AppLogLevel.INFO,
            category: AppLogCategory.BOOKING,
            message: '预约核验成功',
            route: `/bookings/${bookingId}/verify`,
            context: { bookingId, verifiedBy: openid },
        });
        return await this.bookingRepository.getBookingById(bookingId);
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
