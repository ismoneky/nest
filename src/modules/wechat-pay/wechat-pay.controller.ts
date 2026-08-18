import { Controller, Post, Get, Param, Body, Headers, HttpStatus, Res, RawBodyRequest, Req, Logger, UsePipes } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Request, Response } from 'express';
import { WechatPayService } from './wechat-pay.service';
import { LoggingService } from '../logging/logging.service';
import { AppLogLevel, AppLogSource, AppLogCategory } from '../../entities/app-log.entity';

/**
 * 微信支付回调控制器
 */
@Controller('wechat-pay')
export class WechatPayController {
    private readonly logger = new Logger(WechatPayController.name);

    constructor(
        private readonly wechatPayService: WechatPayService,
        private readonly loggingService: LoggingService,
    ) {}

    /**
     * 查询本地订单支付状态（前端轮询用）
     * GET /wechat-pay/query/out-trade-no/:outTradeNo
     * 直接查数据库，不请求微信 API
     */
    @Get('query/out-trade-no/:outTradeNo')
    async queryByOutTradeNo(@Param('outTradeNo') outTradeNo: string) {
        const booking = await this.wechatPayService.getLocalPaymentStatus(outTradeNo);
        return {
            outTradeNo: booking.outTradeNo,
            transactionId: booking.transactionId ?? null,
            paymentStatus: booking.paymentStatus,
            bookingStatus: booking.status,
            paidAt: booking.paidAt ?? null,
        };
    }

    /**
     * 支付结果通知
     * POST /wechat-pay/notify
     * 官方要求：
     *   - 收到后立即验签，5s 内应答
     *   - 验签通过：返回 200，无应答报文
     *   - 验签失败：返回 4XX/5XX + { code: 'FAIL', message }
     *   - 业务处理（更新订单）在应答后异步执行，避免超时
     */
    @Post('notify')
    @UsePipes(new ValidationPipe({ whitelist: false }))
    async handlePaymentNotify(
        @Req() req: RawBodyRequest<Request>,
        @Body() body: any,
        @Headers() headers: any,
        @Res() res: Response,
    ) {
        // 使用原始请求体验签，避免 JSON 序列化后字段顺序变化导致验签失败
        const rawBody = req.rawBody?.toString('utf8') ?? JSON.stringify(body);

        const verifyResult = this.wechatPayService.verifyPaymentNotify(rawBody, headers);
        if (!verifyResult.valid) {
            this.logger.warn(`支付回调验签失败: ${verifyResult.reason}`);
            return res.status(HttpStatus.UNAUTHORIZED).json({ code: 'FAIL', message: verifyResult.reason });
        }

        // 验签通过，立即应答 200（无 body），再异步处理业务
        res.status(HttpStatus.OK).end();

        // 异步处理，不阻塞应答
        setImmediate(async () => {
            try {
                const result = this.wechatPayService.parsePaymentNotify(body);
                if (result) {
                    await this.wechatPayService.handlePaymentSuccess(result.outTradeNo, result.transactionId);
                    this.logger.log(`支付回调处理成功: ${result.outTradeNo}`);
                    // 记录点：支付回调处理成功（日志失败不影响业务结果）
                    this.loggingService.write({
                        source: AppLogSource.BACKEND,
                        level: AppLogLevel.INFO,
                        category: AppLogCategory.PAYMENT,
                        message: '支付回调处理成功',
                        route: '/wechat-pay/notify',
                        context: { outTradeNo: result.outTradeNo },
                    });
                }
            } catch (error) {
                this.logger.error('支付回调业务处理失败', error);
                this.loggingService.write({
                    source: AppLogSource.BACKEND,
                    level: AppLogLevel.ERROR,
                    category: AppLogCategory.PAYMENT,
                    message: '支付回调业务处理失败',
                    route: '/wechat-pay/notify',
                    context: { error: (error as Error).message },
                });
            }
        });
    }

    /**
     * 退款结果通知
     * POST /wechat-pay/refund-notify
     */
    @Post('refund-notify')
    @UsePipes(new ValidationPipe({ whitelist: false }))
    async handleRefundNotify(
        @Req() req: RawBodyRequest<Request>,
        @Body() body: any,
        @Headers() headers: any,
        @Res() res: Response,
    ) {
        const rawBody = req.rawBody?.toString('utf8') ?? JSON.stringify(body);

        const verifyResult = this.wechatPayService.verifyPaymentNotify(rawBody, headers);
        if (!verifyResult.valid) {
            this.logger.warn(`退款回调验签失败: ${verifyResult.reason}`);
            return res.status(HttpStatus.UNAUTHORIZED).json({ code: 'FAIL', message: verifyResult.reason });
        }

        res.status(HttpStatus.OK).end();

        setImmediate(async () => {
            try {
                const result = this.wechatPayService.parseRefundNotify(body);
                if (result) {
                    await this.wechatPayService.handleRefundCallback(result.outTradeNo, result.refundStatus);
                    this.logger.log(`退款回调处理完成: ${result.outTradeNo}, 状态: ${result.refundStatus}`);
                    // 记录点：退款回调处理结果（日志失败不影响业务结果）
                    this.loggingService.write({
                        source: AppLogSource.BACKEND,
                        level: AppLogLevel.INFO,
                        category: AppLogCategory.PAYMENT,
                        message: '退款回调处理完成',
                        route: '/wechat-pay/refund-notify',
                        context: { outTradeNo: result.outTradeNo, refundStatus: result.refundStatus },
                    });
                }
            } catch (error) {
                this.logger.error('退款回调业务处理失败', error);
                this.loggingService.write({
                    source: AppLogSource.BACKEND,
                    level: AppLogLevel.ERROR,
                    category: AppLogCategory.PAYMENT,
                    message: '退款回调业务处理失败',
                    route: '/wechat-pay/refund-notify',
                    context: { error: (error as Error).message },
                });
            }
        });
    }
}
