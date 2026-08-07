import { Injectable, BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource, EntityManager } from 'typeorm';
import { randomUUID } from 'crypto';
import { BookingRepository } from '../../repositories/booking.repository';
import { AdminApplicationRepository } from '../../repositories/admin-application.repository';
import { CreateBookingDto, PassengerDto } from './dto/createBooking.dto';
import { GetBookingsDto } from './dto/getBookings.dto';
import { UpdateBookingDto } from './dto/updateBooking.dto';
import { TimeSlot, TravelMode, VehicleType, BookingStatus, PaymentStatus, RefundStatus, Booking } from '../../entities/booking.entity';
import { SystemConfig } from '../../entities/system-config.entity';
import { WechatPayService } from '../wechat-pay/wechat-pay.service';
import { SystemConfigService } from '../system-config/system-config.service';
import { MemberService } from '../member/member.service';
import { FreeEligibilityResult } from './dto/free-eligibility.dto';
import { normalizeIdCard } from '../../common/utils/id-card.util';

/**
 * 预约订单业务逻辑层
 * 处理预约订单相关的业务逻辑
 */
@Injectable()
export class BookingService {
    private readonly logger = new Logger(BookingService.name);
    private cronRunning = false;
    /** 预约白名单 openid：不受「关闭预约」开关限制（仍走正常金额/名额判定） */
    private readonly whitelistOpenIds: Set<string>;

    constructor(
        private readonly bookingRepository: BookingRepository,
        private readonly wechatPayService: WechatPayService,
        private readonly systemConfigService: SystemConfigService,
        private readonly adminApplicationRepository: AdminApplicationRepository,
        private readonly dataSource: DataSource,
        private readonly memberService: MemberService,
    ) {
        // 从 env 解析白名单（逗号分隔），启动时一次性加载
        const raw = process.env.BOOKING_WHITELIST_OPENIDS || '';
        this.whitelistOpenIds = new Set(
            raw.split(',').map((s) => s.trim()).filter(Boolean),
        );
    }

    /**
     * 创建预约订单
     * @param createBookingDto 创建订单数据
     * @returns 创建的订单
     */
    async createBooking(createBookingDto: CreateBookingDto & { wechatOpenId: string }) {
        // 检查是否允许预约（白名单 openid 不受「关闭预约」开关限制）
        const isWhitelisted = this.whitelistOpenIds.has(createBookingDto.wechatOpenId);
        if (!isWhitelisted) {
            const isBookingEnabled = await this.systemConfigService.isBookingEnabled();
            if (!isBookingEnabled) {
                const disabledMessage = await this.systemConfigService.getBookingDisabledMessage();
                throw new BadRequestException(disabledMessage);
            }
        }

        // 检查预约人数是否超过限制
        const timeSlotLimit = await this.systemConfigService.getTimeSlotLimit();
        // 不再区分上下午，取全天总限额和总已预约人数
        const maxPeople = timeSlotLimit.morningMaxPeople + timeSlotLimit.afternoonMaxPeople;

        // 获取当前日期该时间段的已预约人数
        const currentStats = await this.bookingRepository.getBookingStatsByDate(createBookingDto.bookingDate);
        const currentPeople = currentStats.morning.totalPeople + currentStats.afternoon.totalPeople;

        // 检查加上新预约的人数后是否超过限制
        if (currentPeople + createBookingDto.personCount > maxPeople) {
            throw new BadRequestException(`该时间段预约人数已达上限，当前剩余名额：${maxPeople - currentPeople}`);
        }

        // 事务内：原子地判断免费资格并创建订单，避免并发下免费名额超卖
        return await this.dataSource.transaction(async (entityManager) => {
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

            return await bookingRepo.save(booking);
        });
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
        const target = new Date(bookingDate);
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const nextDay = new Date(todayStart);
        nextDay.setDate(todayStart.getDate() + 1);
        const bookingIsToday = target.getTime() >= todayStart.getTime() && target.getTime() < nextDay.getTime();

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
                .andWhere('booking.bookingDate < :nextDay', { nextDay })
                .getRawOne();
            quotaUsed = parseInt(freeCountResult?.count || '0', 10);

            // 当前用户今日是否已享过每日免费（同样仅算 dailyQuota）
            const userFreeCount = await bookingRepo
                .createQueryBuilder('booking')
                .where('booking.wechatOpenId = :openid', { openid: wechatOpenId })
                .andWhere('booking.isFree = :isFree', { isFree: true })
                .andWhere('booking.freeReason = :reason', { reason: 'dailyQuota' })
                .andWhere('booking.bookingDate >= :dayStart', { dayStart: todayStart })
                .andWhere('booking.bookingDate < :nextDay', { nextDay })
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
            };
        }

        // 6. 收费分支：按优先级定 reason
        //    摩托车且身份证命中会员但车牌未命中 → member_plate_not_matched
        //    摩托车但身份证未命中任何会员 → member_idcard_not_matched
        //    其余 → 按 dailyQuota 三态 / 非今日 / 会员过期分流
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
            // !freeEnabled：免费功能未开启，正常收费
            reason = 'member_expired';
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
        };
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
        const booking = await this.bookingRepository.getBookingById(bookingId);
        if (booking.isFree) {
            throw new BadRequestException('免费预约不支持取消');
        }
        return await this.bookingRepository.deleteBooking(bookingId);
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
     * 定时处理过期订单
     * 每小时执行一次 (减轻服务器压力)
     */
    @Cron(CronExpression.EVERY_5_MINUTES)
    async handleCron() {
        if (this.cronRunning) {
            this.logger.warn('上一次定时任务尚未完成，跳过本次执行');
            return;
        }
        this.cronRunning = true;
        this.logger.debug('Running booking cron job...');
        const now = new Date();
        const todayStr = now.toLocaleDateString('sv');
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        try {
            await Promise.allSettled([
                // 1. 处理之前日期的未完成订单
                this.bookingRepository.updatePastBookings(todayStart).catch((error) => this.logger.error('Error updating past bookings', error)),

                // 2. 退款对账：主动查询 REFUNDING 状态的订单，防止回调丢失导致状态卡住
                this.bookingRepository
                    .getRefundingOrders()
                    .then(async (refundingOrders) => {
                        await Promise.allSettled(
                            refundingOrders
                                .filter((order) => !!order.outRefundNo)
                                .map(async (order) => {
                                    try {
                                        const refundStatus = await this.wechatPayService.queryRefund(order.outRefundNo);
                                        if (refundStatus.status === 'SUCCESS') {
                                            await this.bookingRepository.updateRefundStatus(order.bookingId, RefundStatus.REFUNDED, undefined, PaymentStatus.REFUNDED);
                                            this.logger.log(`退款对账同步成功: ${order.outRefundNo}`);
                                        } else if (refundStatus.status === 'CLOSED' || refundStatus.status === 'ABNORMAL') {
                                            await this.bookingRepository.updateRefundStatus(order.bookingId, RefundStatus.FAILED, undefined, PaymentStatus.FAILED);
                                            this.logger.warn(`退款对账异常: ${order.outRefundNo}, 状态: ${refundStatus.status}`);
                                        }
                                        // PROCESSING 状态不处理，等下次定时任务继续查
                                    } catch (queryError) {
                                        // 微信返回 404（退款单不存在）：退款单可能从未成功创建，
                                        // 将本地状态标记为 FAILED，避免定时任务反复查询不存在的退款单
                                        const errMsg = queryError?.message || '';
                                        if (errMsg.includes('404') || errMsg.includes('RESOURCE_NOT_EXISTS')) {
                                            await this.bookingRepository.updateRefundStatus(order.bookingId, RefundStatus.FAILED, undefined, PaymentStatus.FAILED);
                                            this.logger.warn(`退款单不存在，已标记为失败: ${order.outRefundNo}`);
                                        } else {
                                            this.logger.warn(`查询退款状态失败: ${order.outRefundNo}`, queryError);
                                        }
                                    }
                                }),
                        );
                    })
                    .catch((error) => this.logger.error('退款对账任务失败', error)),

                // 5. 处理支付超时的订单
                // 官方要求：超时后需先调用微信关单 API，再更新本地状态，避免用户支付旧订单触发回调
                this.bookingRepository
                    .getPaymentTimeoutOrders(now)
                    .then(async (timeoutOrders) => {
                        await Promise.allSettled(
                            timeoutOrders
                                .filter((order) => !!order.outTradeNo)
                                .map((order) =>
                                    this.wechatPayService.closeOrder(order.outTradeNo).catch((closeError) => this.logger.warn(`关闭超时订单失败: ${order.bookingId}`, closeError)),
                                ),
                        );
                        await this.bookingRepository.updatePaymentTimeoutOrders(now);
                    })
                    .catch((error) => this.logger.error('Error updating payment timeout orders', error)),
            ]);
        } finally {
            this.cronRunning = false;
        }
    }

    /**
     * 初始化支付
     * @param bookingId 订单ID
     * @returns 支付参数
     */
    async initiatePayment(bookingId: string, openid: string) {
        const booking = await this.bookingRepository.getBookingById(bookingId);
        if (!booking) {
            throw new BadRequestException('订单不存在');
        }

        if (booking.wechatOpenId !== openid) {
            throw new BadRequestException('无权操作该订单');
        }

        if (booking.isFree) {
            throw new BadRequestException('该订单为免费预约，无需支付');
        }

        if (booking.status === BookingStatus.CANCELLED) {
            throw new BadRequestException('订单已取消，无法支付');
        }

        if (booking.paymentStatus !== PaymentStatus.UNPAID && booking.paymentStatus !== PaymentStatus.PAYING) {
            throw new BadRequestException('订单状态不允许支付');
        }

        if (booking.paymentExpiredAt && new Date() > booking.paymentExpiredAt) {
            throw new BadRequestException('支付已超时');
        }

        // 每次发起支付都重新下单，生成新的 outTradeNo
        // 必须先主动关闭旧的微信订单，否则旧单仍处于 USERPAYING 状态，
        // 微信会拒绝新下单并返回 ORDER_CLOSED 错误。
        // closeOrder 内部已做容错，旧单已关闭/已支付时不会抛异常。
        if (booking.outTradeNo) {
            await this.wechatPayService.closeOrder(booking.outTradeNo);
        }

        const paymentParams = await this.wechatPayService.createPayment(
            booking.bookingId,
            booking.amount,
            `预约订单 - ${booking.bookingDate}`,
            booking.wechatOpenId,
            booking.paymentExpiredAt,
        );

        // 更新支付状态为支付中（bookingStatus 保持 PENDING，等待微信回调确认）
        await this.bookingRepository.updatePaymentStatus(bookingId, PaymentStatus.PAYING, paymentParams.outTradeNo);

        return paymentParams;
    }

    /**
     * 查询支付状态
     * @param bookingId 订单ID
     * @returns 支付状态
     */
    async getPaymentStatus(bookingId: string) {
        const booking = await this.bookingRepository.getBookingById(bookingId);
        if (!booking) {
            throw new BadRequestException('订单不存在');
        }

        if (booking.paymentStatus === PaymentStatus.PAID) {
            return {
                status: booking.paymentStatus,
                paidAt: booking.paidAt,
                transactionId: booking.transactionId,
            };
        }

        // 本地未支付但有微信订单号，主动查微信侧状态兜底
        // 处理 notify 回调延迟导致本地状态滞后的情况
        if (booking.outTradeNo) {
            const orderStatus = await this.wechatPayService.queryOrder(booking.outTradeNo);

            if (orderStatus.trade_state === 'SUCCESS') {
                // 微信侧已支付，主动同步本地状态（兜底，正常由 notify 回调更新）
                await this.wechatPayService.handlePaymentSuccess(booking.outTradeNo, orderStatus.transaction_id);
                return {
                    status: PaymentStatus.PAID,
                    paidAt: new Date(),
                    transactionId: orderStatus.transaction_id,
                };
            }

            return { status: booking.paymentStatus };
        }

        return { status: booking.paymentStatus };
    }

    /**
     * 申请退款
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

        // 幂等保护：先确保退款单号持久化，再发起退款
        // 使用固定单号（不含时间戳），保证重试时单号不变，避免重复退款
        const outRefundNo = booking.outRefundNo ?? `RF${booking.bookingId}`;
        if (!booking.outRefundNo) {
            await this.bookingRepository.updateRefundStatus(bookingId, RefundStatus.REFUNDING, outRefundNo, PaymentStatus.REFUNDING);
        }

        // 申请退款
        const refundResult = await this.wechatPayService.refund(booking.outTradeNo, outRefundNo, booking.amount, booking.amount);

        return refundResult;
    }

    /**
     * 更新支付状态
     * @param outTradeNo 商户订单号
     * @param transactionId 微信支付订单号
     * @param status 支付状态
     */
    async updatePaymentStatus(outTradeNo: string, transactionId: string, status: string) {
        if (status === 'SUCCESS') {
            // 支付成功：paymentStatus → PAID，bookingStatus → CONFIRMED（预约正式生效）
            await this.bookingRepository.updatePaymentStatusByOutTradeNo(outTradeNo, PaymentStatus.PAID, BookingStatus.CONFIRMED, transactionId, new Date());
        }
    }

    /**
     * 处理支付超时
     * @param bookingId 订单ID
     */
    async handlePaymentTimeout(bookingId: string) {
        // 支付超时：paymentStatus → UNPAID，bookingStatus → CANCELLED
        await this.bookingRepository.updatePaymentStatus(bookingId, PaymentStatus.UNPAID, null, BookingStatus.CANCELLED);
    }

    /**
     * 更新退款状态
     * @param bookingId 订单ID
     * @param refundStatus 退款状态
     */
    async updateRefundStatus(bookingId: string, refundStatus: RefundStatus) {
        return await this.bookingRepository.updateRefundStatus(bookingId, refundStatus);
    }

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
            throw new BadRequestException(`订单状态不可核验，当前状态：${booking.status}`);
        }

        return await this.bookingRepository.updateBooking(bookingId, { status: BookingStatus.COMPLETED } as any);
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
