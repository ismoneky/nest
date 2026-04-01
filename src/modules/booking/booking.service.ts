import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BookingRepository } from '../../repositories/booking.repository';
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
    ) {}

    /**
     * 创建预约订单
     * @param createBookingDto 创建订单数据
     * @returns 创建的订单
     */
    async createBooking(createBookingDto: CreateBookingDto) {
        // 检查是否允许预约
        const isBookingEnabled = await this.systemConfigService.isBookingEnabled();
        if (!isBookingEnabled) {
            const disabledMessage = await this.systemConfigService.getBookingDisabledMessage();
            throw new BadRequestException(disabledMessage);
        }

        // 计算预约时间的具体时间点
        const bookingDate = new Date(createBookingDto.bookingDate);
        // 设置预约时间的完整日期和时间段
        const [year, month, day] = createBookingDto.bookingDate.split('-').map(Number);
        bookingDate.setFullYear(year, month - 1, day); // 设置预约日期

        if (createBookingDto.timeSlot === TimeSlot.MORNING) {
            bookingDate.setHours(12, 0, 0, 0); // 上午 12:00
        } else if (createBookingDto.timeSlot === TimeSlot.AFTERNOON) {
            bookingDate.setHours(18, 0, 0, 0); // 下午 18:00
        }

        // 计算延迟时间（预约时间 - 当前时间）
        const delay = bookingDate.getTime() - Date.now();
        if (delay <= 0) {
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
        const amount = createBookingDto.personCount * paymentConfig.paymentAmount * 100; // 转换为分

        // 设置支付超时时间（30分钟）
        const paymentExpiredAt = new Date();
        paymentExpiredAt.setMinutes(paymentExpiredAt.getMinutes() + 30);

        // 创建订单，设置状态为待支付
        const booking = await this.bookingRepository.createBooking({
            ...createBookingDto,
            status: BookingStatus.PENDING_PAYMENT,
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

    /**
     * 定时处理过期订单
     * 每小时执行一次 (减轻服务器压力)
     */
    // @Cron(CronExpression.EVERY_MINUTE)
    @Cron(CronExpression.EVERY_HOUR)
    async handleCron() {
        this.logger.debug('Running booking cron job...');
        const now = new Date();
        // 确保构造的是 UTC 时间的 00:00:00，与 createBooking 时的 new Date(string) 保持一致
        const todayStart = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));

        // 1. 处理之前日期的未完成订单
        try {
            await this.bookingRepository.updatePastBookings(todayStart);
        } catch (error) {
            this.logger.error('Error updating past bookings', error);
        }

        // 2. 处理今天上午过期的订单 (12:00后)
        if (now.getHours() >= 12) {
            try {
                await this.bookingRepository.updateExpiredBookings(todayStart, TimeSlot.MORNING);
            } catch (error) {
                this.logger.error('Error updating morning bookings', error);
            }
        }

        // 3. 处理今天下午过期的订单 (18:00后)
        if (now.getHours() >= 18) {
            try {
                await this.bookingRepository.updateExpiredBookings(todayStart, TimeSlot.AFTERNOON);
            } catch (error) {
                this.logger.error('Error updating afternoon bookings', error);
            }
        }

        // 4. 处理支付超时的订单
        try {
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
    async initiatePayment(bookingId: string) {
        const booking = await this.bookingRepository.getBookingById(bookingId);
        if (!booking) {
            throw new BadRequestException('订单不存在');
        }

        if (booking.paymentStatus !== PaymentStatus.UNPAID) {
            throw new BadRequestException('订单状态不允许支付');
        }

        if (booking.paymentExpiredAt && new Date() > booking.paymentExpiredAt) {
            throw new BadRequestException('支付已超时');
        }

        // 创建支付订单
        const paymentParams = await this.wechatPayService.createPayment(
            booking.bookingId,
            booking.amount,
            `预约订单 - ${booking.bookingDate} ${booking.timeSlot}`,
            booking.wechatOpenId
        );

        // 更新订单状态为支付中
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

        if (booking.outTradeNo) {
            const orderStatus = await this.wechatPayService.queryOrder(booking.outTradeNo);
            return {
                status: booking.paymentStatus,
                wechatStatus: orderStatus.trade_state,
            };
        }

        return {
            status: booking.paymentStatus,
        };
    }

    /**
     * 申请退款
     * @param bookingId 订单ID
     * @returns 退款结果
     */
    async initiateRefund(bookingId: string) {
        const booking = await this.bookingRepository.getBookingById(bookingId);
        if (!booking) {
            throw new BadRequestException('订单不存在');
        }

        if (booking.paymentStatus !== PaymentStatus.PAID) {
            throw new BadRequestException('订单未支付，无法退款');
        }

        if (booking.refundStatus !== RefundStatus.NONE) {
            throw new BadRequestException('退款已处理');
        }

        // 生成退款单号
        const outRefundNo = `REFUND_${booking.bookingId}_${Date.now()}`;

        // 申请退款
        const refundResult = await this.wechatPayService.refund(
            booking.outTradeNo,
            outRefundNo,
            booking.amount,
            booking.amount
        );

        // 更新订单状态为退款中
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
            await this.bookingRepository.updatePaymentStatusByOutTradeNo(
                outTradeNo,
                PaymentStatus.PAID,
                BookingStatus.PAID,
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
     * 根据商户订单号查询订单
     * @param outTradeNo 商户订单号
     * @returns 订单
     */
    async getBookingByOutTradeNo(outTradeNo: string) {
        return await this.bookingRepository.getBookingByOutTradeNo(outTradeNo);
    }
}
