import { Controller, Post, Body, Headers, HttpStatus, Res, Logger, BadRequestException } from '@nestjs/common';
import { Response } from 'express';
import { WechatPayService } from './wechat-pay.service';

/**
 * 微信支付控制器
 * 处理微信支付相关的HTTP请求
 */
@Controller('wechat-pay')
export class WechatPayController {
    private readonly logger = new Logger(WechatPayController.name);

    constructor(
        private readonly wechatPayService: WechatPayService,
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
                await this.wechatPayService.handlePaymentSuccess(result.outTradeNo, result.transactionId);
                this.logger.log(`支付回调处理成功: ${result.outTradeNo}`);
            }

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
                const signature = headers['wechatpay-signature'];
                const timestamp = headers['wechatpay-timestamp'];
                const nonce = headers['wechatpay-nonce'];
                const serialNo = headers['wechatpay-serial'];

                const isValid = await this.wechatPayService.verifyCallback(
                    JSON.stringify(body),
                    signature,
                    timestamp,
                    nonce,
                    serialNo
                );

                if (!isValid) {
                    throw new BadRequestException('回调签名验证失败');
                }

                const decryptedData = this.wechatPayService.decryptResource(resource);
                const { out_trade_no, refund_status } = decryptedData;

                await this.wechatPayService.handleRefundCallback(out_trade_no, refund_status);
                this.logger.log(`退款回调处理完成: ${out_trade_no}, 状态: ${refund_status}`);
            }

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
