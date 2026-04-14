import { Injectable, BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BookingRepository } from '../../repositories/booking.repository';
import { AdminApplicationRepository } from '../../repositories/admin-application.repository';
import { CreateBookingDto } from './dto/createBooking.dto';
import { GetBookingsDto } from './dto/getBookings.dto';
import { UpdateBookingDto } from './dto/updateBooking.dto';
import { TimeSlot, BookingStatus, PaymentStatus, RefundStatus } from '../../entities/booking.entity';
import { WechatPayService } from '../wechat-pay/wechat-pay.service';
import { SystemConfigService } from '../system-config/system-config.service';

/**
 * 预约订单业务逻辑层
 * 处理预约订单相关的业务逻辑
 */
@Injectable()
export class BookingService {
    private readonly logger = new Logger(BookingService.name);

    constructor(
        private readonly bookingRepository: BookingRepository,
        private readonly wechatPayService: WechatPayService,
        private readonly systemConfigService: SystemConfigService,
        private readonly adminApplicationRepository: AdminApplicationRepository,
    ) {}

    /**
     * 创建预约订单
     * @param createBookingDto 创建订单数据
     * @returns 创建的订单
     */
    async createBooking(createBookingDto: CreateBookingDto & { wechatOpenId: string }) {
        // 检查是否允许预约
        const isBookingEnabled = await this.systemConfigService.isBookingEnabled();
        if (!isBookingEnabled) {
            const disabledMessage = await this.systemConfigService.getBookingDisabledMessage();
            throw new BadRequestException(disabledMessage);
        }

        // 用 UTC 构造预约时间点，与定时任务的 todayStart 基准保持一致
        const [year, month, day] = createBookingDto.bookingDate.split('-').map(Number);
        // 上午场次截止 UTC 04:00（北京时间 12:00），下午场次截止 UTC 10:00（北京时间 18:00）
        const slotHourUTC = createBookingDto.timeSlot === TimeSlot.MORNING ? 4 : 10;
        const bookingDate = new Date(Date.UTC(year, month - 1, day, slotHourUTC, 0, 0, 0));

        if (bookingDate.getTime() <= Date.now()) {
            throw new BadRequestException('预约时间必须晚于当前时间');
        }

        // 检查预约人数是否超过限制
        const timeSlotLimit = await this.systemConfigService.getTimeSlotLimit();
        const maxPeople = createBookingDto.timeSlot === TimeSlot.MORNING 
            ? timeSlotLimit.morningMaxPeople 
            : timeSlotLimit.afternoonMaxPeople;

        // 获取当前日期该时间段的已预约人数
        const currentStats = await this.bookingRepository.getBookingStatsByDate(createBookingDto.bookingDate);
        const currentPeople = createBookingDto.timeSlot === TimeSlot.MORNING 
            ? currentStats.morning.totalPeople 
            : currentStats.afternoon.totalPeople;

        // 检查加上新预约的人数后是否超过限制
        if (currentPeople + createBookingDto.personCount > maxPeople) {
            throw new BadRequestException(`该时间段预约人数已达上限，当前剩余名额：${maxPeople - currentPeople}`);
        }

        // 计算支付金额（从系统配置获取）
        const paymentConfig = await this.systemConfigService.getPaymentConfig();
        const amount = createBookingDto.personCount * paymentConfig.paymentAmount; // 转换为分

        // 设置支付超时时间（30分钟）
        const paymentExpiredAt = new Date();
        paymentExpiredAt.setMinutes(paymentExpiredAt.getMinutes() + 30);

        // 创建订单，初始状态：预约待确认 + 未支付
        const booking = await this.bookingRepository.createBooking({
            ...createBookingDto,
            status: BookingStatus.PENDING,
            paymentStatus: PaymentStatus.UNPAID,
            refundStatus: RefundStatus.NONE,
            amount,
            paymentExpiredAt,
        });

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
    async getBookingsForAdmin(query: {
        bookingDate?: string;
        timeSlot?: TimeSlot;
        status?: BookingStatus;
        keyword?: string;
        page?: number;
        pageSize?: number;
    }) {
        return await this.bookingRepository.getBookingsForAdmin(query);
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
        this.logger.debug('Running booking cron job...');
        const now = new Date();
        // todayStr 用于 date 列的精确匹配（YYYY-MM-DD 字符串）
        const todayStr = now.toLocaleDateString('sv'); // 'sv' locale 输出 YYYY-MM-DD
        // todayStart 用于 updatePastBookings 的 < 比较
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        // 1. 处理之前日期的未完成订单
        try {
            await this.bookingRepository.updatePastBookings(todayStart);
        } catch (error) {
            this.logger.error('Error updating past bookings', error);
        }

        // 2. 处理今天上午过期的订单 (12:00后)
        if (now.getHours() >= 12) {
            try {
                await this.bookingRepository.updateExpiredBookings(todayStr, TimeSlot.MORNING);
            } catch (error) {
                this.logger.error('Error updating morning bookings', error);
            }
        }

        // 3. 处理今天下午过期的订单 (18:00后)
        if (now.getHours() >= 18) {
            try {
                await this.bookingRepository.updateExpiredBookings(todayStr, TimeSlot.AFTERNOON);
            } catch (error) {
                this.logger.error('Error updating afternoon bookings', error);
            }
        }

        // 4. 处理支付超时的订单
        // 官方要求：超时后需先调用微信关单 API，再更新本地状态，避免用户支付旧订单触发回调
        try {
            const timeoutOrders = await this.bookingRepository.getPaymentTimeoutOrders(now);
            for (const order of timeoutOrders) {
                try {
                    if (order.outTradeNo) {
                        await this.wechatPayService.closeOrder(order.outTradeNo);
                    }
                } catch (closeError) {
                    this.logger.warn(`关闭超时订单失败: ${order.bookingId}`, closeError);
                }
            }
            await this.bookingRepository.updatePaymentTimeoutOrders(now);
        } catch (error) {
            this.logger.error('Error updating payment timeout orders', error);
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

        if (booking.status === BookingStatus.CANCELLED) {
            throw new BadRequestException('订单已取消，无法支付');
        }

        if (booking.paymentStatus !== PaymentStatus.UNPAID && booking.paymentStatus !== PaymentStatus.PAYING) {
            throw new BadRequestException('订单状态不允许支付');
        }

        if (booking.paymentExpiredAt && new Date() > booking.paymentExpiredAt) {
            throw new BadRequestException('支付已超时');
        }

        // 若已有进行中的微信订单（PAYING 状态），先关闭旧订单再重新下单
        // 官方要求：重新下单前必须关闭旧的未支付订单，避免用户支付旧订单触发回调导致状态混乱
        if (booking.paymentStatus === PaymentStatus.PAYING && booking.outTradeNo) {
            await this.wechatPayService.closeOrder(booking.outTradeNo);
        }

        // 每次发起支付都重新下单，生成新的 outTradeNo
        const paymentParams = await this.wechatPayService.createPayment(
            booking.bookingId,
            booking.amount,
            `预约订单 - ${booking.bookingDate} ${booking.timeSlot}`,
            booking.wechatOpenId,
            booking.paymentExpiredAt,
        );

        // 更新支付状态为支付中（bookingStatus 保持 PENDING，等待微信回调确认）
        await this.bookingRepository.updatePaymentStatus(
            bookingId,
            PaymentStatus.PAYING,
            paymentParams.outTradeNo
        );

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
                await this.wechatPayService.handlePaymentSuccess(
                    booking.outTradeNo,
                    orderStatus.transaction_id,
                );
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

        if (booking.paymentStatus !== PaymentStatus.PAID) {
            throw new BadRequestException('订单未支付，无法退款');
        }

        if (booking.refundStatus === RefundStatus.REFUNDED) {
            throw new BadRequestException('订单已退款');
        }

        // 幂等保护：若已有退款单号（上次请求可能超时），复用原单号重试，避免重复退款
        // 仅允许 NONE 和 REFUNDING（上次请求结果未知）状态重试
        const outRefundNo = booking.outRefundNo ?? `RF${booking.bookingId}${Date.now()}`;

        // 申请退款
        const refundResult = await this.wechatPayService.refund(
            booking.outTradeNo,
            outRefundNo,
            booking.amount,
            booking.amount
        );

        // 更新订单状态为退款中，同时持久化退款单号
        await this.bookingRepository.updateRefundStatus(
            bookingId,
            RefundStatus.REFUNDING,
            outRefundNo
        );

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
            await this.bookingRepository.updatePaymentStatusByOutTradeNo(
                outTradeNo,
                PaymentStatus.PAID,
                BookingStatus.CONFIRMED,
                transactionId,
                new Date()
            );
        }
    }

    /**
     * 处理支付超时
     * @param bookingId 订单ID
     */
    async handlePaymentTimeout(bookingId: string) {
        // 支付超时：paymentStatus → UNPAID，bookingStatus → CANCELLED
        await this.bookingRepository.updatePaymentStatus(
            bookingId,
            PaymentStatus.UNPAID,
            null,
            BookingStatus.CANCELLED
        );
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
}
