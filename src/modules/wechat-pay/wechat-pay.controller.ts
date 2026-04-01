import { Controller, Post, Body, Headers, HttpStatus, Res, Logger, BadRequestException } from '@nestjs/common';
import { Response } from 'express';
import { WechatPayService } from './wechat-pay.service';
import { BookingService } from '../booking/booking.service';
import { RefundStatus } from '../../entities/booking.entity';

/**
 * 微信支付控制器
 * 处理微信支付相关的HTTP请求
 */
@Controller('wechat-pay')
export class WechatPayController {
    private readonly logger = new Logger(WechatPayController.name);

    constructor(
        private readonly wechatPayService: WechatPayService,
        private readonly bookingService: BookingService
    ) {}

    /**
     * 处理微信支付回调
     * POST /wechat-pay/notify
     */
    @Post('notify')
    async handlePaymentNotify(@Body() body: any, @Headers() headers: any, @Res() res: Response) {
        try {
            const result = await this.wechatPayService.handlePaymentNotify(body, headers);

            if (result) {
                // 更新订单状态
                await this.bookingService.updatePaymentStatus(result.outTradeNo, result.transactionId, result.status);
                this.logger.log(`支付回调处理成功: ${result.outTradeNo}`);
            }

            // 返回成功响应给微信支付平台
            return res.status(HttpStatus.OK).send({
                code: 'SUCCESS',
                message: '成功',
            });
        } catch (error) {
            this.logger.error('处理支付回调失败', error);
            return res.status(HttpStatus.BAD_REQUEST).send({
                code: 'FAIL',
                message: '失败',
            });
        }
    }

    /**
     * 处理微信退款回调
     * POST /wechat-pay/refund-notify
     */
    @Post('refund-notify')
    async handleRefundNotify(@Body() body: any, @Headers() headers: any, @Res() res: Response) {
        try {
            const { resource, event_type } = body;

            if (event_type === 'REFUND.SUCCESS') {
                // 验证回调签名
                const signature = headers['wechatpay-signature'];
                const timestamp = headers['wechatpay-timestamp'];
                const nonce = headers['wechatpay-nonce'];
                const serialNo = headers['wechatpay-serial'];

                const isValid = this.wechatPayService.verifyCallback(
                    JSON.stringify(body),
                    signature,
                    timestamp,
                    nonce,
                    serialNo
                );

                if (!isValid) {
                    throw new BadRequestException('回调签名验证失败');
                }

                // 解密回调数据
                const decryptedData = this.wechatPayService.decryptResource(resource);
                const { out_trade_no, refund_status } = decryptedData;

                // 根据商户订单号查询订单
                const booking = await this.bookingService.getBookingByOutTradeNo(out_trade_no);

                // 更新退款状态
                if (refund_status === 'SUCCESS') {
                    await this.bookingService.updateRefundStatus(booking.bookingId, RefundStatus.REFUNDED);
                    this.logger.log(`退款回调处理成功: ${out_trade_no}`);
                } else if (refund_status === 'FAILED') {
                    await this.bookingService.updateRefundStatus(booking.bookingId, RefundStatus.FAILED);
                    this.logger.log(`退款回调处理失败: ${out_trade_no}`);
                }
            }

            // 返回成功响应给微信支付平台
            return res.status(HttpStatus.OK).send({
                code: 'SUCCESS',
                message: '成功',
            });
        } catch (error) {
            this.logger.error('处理退款回调失败', error);
            return res.status(HttpStatus.BAD_REQUEST).send({
                code: 'FAIL',
                message: '失败',
            });
        }
    }
}
