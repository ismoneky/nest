import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '../../config/config.service';
import WechatPay from 'wechatpay-node-v3';
import { readFileSync } from 'fs';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';

/**
 * 微信支付服务
 * 处理微信支付相关的业务逻辑
 */
@Injectable()
export class WechatPayService {
    private readonly logger = new Logger(WechatPayService.name);
    private wechatpay: any;

    constructor(private configService: ConfigService) {
        this.initWechatPay();
    }

    /**
     * 初始化微信支付客户端
     */
    private initWechatPay() {
        try {
            const appid = process.env.WX_APPID || '';
            const mchid = process.env.WX_MCHID || '';
            const privateKeyPath = process.env.WX_PRIVATE_KEY_PATH || '';
            const serialNo = process.env.WX_SERIAL_NO || '';
            const apiV3Key = process.env.WX_API_V3_KEY || '';

            if (!appid || !mchid || !privateKeyPath || !serialNo || !apiV3Key) {
                this.logger.error('微信支付配置不完整');
                return;
            }

            const privateKey = readFileSync(join(__dirname, '../../..', privateKeyPath));

            this.wechatpay = new WechatPay({
                appid,
                mchid,
                publicKey: Buffer.from(''), // 平台证书，可通过自动更新获取
                privateKey,
                serial_no: serialNo,
                key: apiV3Key,
            });

            this.logger.log('微信支付客户端初始化成功');
        } catch (error) {
            this.logger.error('微信支付客户端初始化失败', error);
        }
    }

    /**
     * 创建微信支付订单
     * @param bookingId 订单ID
     * @param amount 支付金额（单位：分）
     * @param description 商品描述
     * @param openid 微信用户OpenID
     * @returns 支付参数
     */
    async createPayment(bookingId: string, amount: number, description: string, openid: string) {
        if (!this.wechatpay) {
            throw new BadRequestException('微信支付客户端未初始化');
        }

        try {
            const outTradeNo = `BOOKING_${bookingId}_${Date.now()}_${uuidv4().substring(0, 8)}`;
            const notifyUrl = `${this.configService.getApiBaseUrl()}/wechat-pay/notify`;

            const result = await this.wechatpay.transactions.jsapi({
                description,
                out_trade_no: outTradeNo,
                notify_url: notifyUrl,
                amount: {
                    total: amount,
                    currency: 'CNY',
                },
                payer: {
                    openid,
                },
            });

            return {
                outTradeNo,
                prepayId: result.prepay_id,
                timestamp: Math.floor(Date.now() / 1000).toString(),
                nonceStr: uuidv4(),
            };
        } catch (error) {
            this.logger.error('创建微信支付订单失败', error);
            throw new BadRequestException('创建支付订单失败');
        }
    }

    /**
     * 处理微信支付回调
     * @param body 回调数据
     * @param headers 回调头信息
     * @returns 处理结果
     */
    async handlePaymentNotify(body: any, headers: any) {
        if (!this.wechatpay) {
            throw new BadRequestException('微信支付客户端未初始化');
        }

        try {
            const { resource, event_type, resource_type, trade_state } = body;

            if (event_type === 'TRANSACTION.SUCCESS' && trade_state === 'SUCCESS') {
                // 验证回调签名
                const signature = headers['wechatpay-signature'];
                const timestamp = headers['wechatpay-timestamp'];
                const nonce = headers['wechatpay-nonce'];
                const serialNo = headers['wechatpay-serial'];

                const isValid = this.wechatpay.verifyCallback(
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
                const decryptedData = this.wechatpay.decryptResource(resource);
                const { out_trade_no, transaction_id, trade_state: status, payer } = decryptedData;

                return {
                    outTradeNo: out_trade_no,
                    transactionId: transaction_id,
                    status,
                    openid: payer.openid,
                };
            }

            return null;
        } catch (error) {
            this.logger.error('处理微信支付回调失败', error);
            throw new BadRequestException('处理支付回调失败');
        }
    }

    /**
     * 申请退款
     * @param outTradeNo 商户订单号
     * @param outRefundNo 退款单号
     * @param totalAmount 总金额（单位：分）
     * @param refundAmount 退款金额（单位：分）
     * @returns 退款结果
     */
    async refund(outTradeNo: string, outRefundNo: string, totalAmount: number, refundAmount: number) {
        if (!this.wechatpay) {
            throw new BadRequestException('微信支付客户端未初始化');
        }

        try {
            const result = await this.wechatpay.refund.domestic({
                out_trade_no: outTradeNo,
                out_refund_no: outRefundNo,
                amount: {
                    refund: refundAmount,
                    total: totalAmount,
                    currency: 'CNY',
                },
                notify_url: `${this.configService.getApiBaseUrl()}/wechat-pay/refund-notify`,
            });

            return result;
        } catch (error) {
            this.logger.error('申请退款失败', error);
            throw new BadRequestException('申请退款失败');
        }
    }

    /**
     * 查询订单状态
     * @param outTradeNo 商户订单号
     * @returns 订单状态
     */
    async queryOrder(outTradeNo: string) {
        if (!this.wechatpay) {
            throw new BadRequestException('微信支付客户端未初始化');
        }

        try {
            const result = await this.wechatpay.transactions.query({ out_trade_no: outTradeNo });
            return result;
        } catch (error) {
            this.logger.error('查询订单状态失败', error);
            throw new BadRequestException('查询订单状态失败');
        }
    }

    /**
     * 验证回调签名
     * @param body 回调数据
     * @param signature 签名
     * @param timestamp 时间戳
     * @param nonce 随机字符串
     * @param serialNo 证书序列号
     * @returns 是否有效
     */
    verifyCallback(body: string, signature: string, timestamp: string, nonce: string, serialNo: string): boolean {
        if (!this.wechatpay) {
            return false;
        }

        try {
            return this.wechatpay.verifyCallback(body, signature, timestamp, nonce, serialNo);
        } catch (error) {
            this.logger.error('验证回调签名失败', error);
            return false;
        }
    }

    /**
     * 解密回调数据
     * @param resource 加密的资源数据
     * @returns 解密后的数据
     */
    decryptResource(resource: any): any {
        if (!this.wechatpay) {
            throw new BadRequestException('微信支付客户端未初始化');
        }

        try {
            return this.wechatpay.decryptResource(resource);
        } catch (error) {
            this.logger.error('解密回调数据失败', error);
            throw new BadRequestException('解密回调数据失败');
        }
    }
}
