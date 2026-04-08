import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '../../config/config.service';
import { Booking, BookingStatus, PaymentStatus, RefundStatus } from '../../entities/booking.entity';
import WechatPay from 'wechatpay-node-v3';
import { readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID, createSign } from 'crypto';

/**
 * 微信支付服务
 * 处理微信支付相关的业务逻辑
 */
@Injectable()
export class WechatPayService {
    private readonly logger = new Logger(WechatPayService.name);
    private wechatpay: any;
    private privateKey: Buffer;
    private appid: string;

    constructor(
        private configService: ConfigService,
        @InjectRepository(Booking)
        private readonly bookingRepository: Repository<Booking>,
    ) {
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
            this.privateKey = privateKey;
            this.appid = appid;

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
            // 微信 out_trade_no 最长 32 位：bookingId(13位) + 时间戳后6位 + 随机4位 = 23位
            const outTradeNo = `${bookingId}${Date.now().toString().slice(-6)}${randomUUID().replace(/-/g, '').substring(0, 4)}`;
            const notifyUrl = `${this.configService.getApiBaseUrl()}/wechat-pay/notify`;

            const result = await this.wechatpay.transactions_jsapi({
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

            const timestamp = Math.floor(Date.now() / 1000).toString();
            const nonceStr = randomUUID().replace(/-/g, '');
            const prepayId = result.prepay_id;

            // 按微信文档要求拼接签名串：appId\ntimeStamp\nnonceStr\npackage\n
            const signStr = `${this.appid}\n${timestamp}\n${nonceStr}\nprepay_id=${prepayId}\n`;
            const paySign = createSign('RSA-SHA256')
                .update(signStr)
                .sign(this.privateKey, 'base64');

            return {
                outTradeNo,
                appId: this.appid,
                timeStamp: timestamp,
                nonceStr,
                package: `prepay_id=${prepayId}`,
                signType: 'RSA',
                paySign,
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
            const { resource, event_type } = body;

            if (event_type === 'TRANSACTION.SUCCESS') {
                // 验证回调签名
                const signature = headers['wechatpay-signature'];
                const timestamp = headers['wechatpay-timestamp'];
                const nonce = headers['wechatpay-nonce'];
                const serialNo = headers['wechatpay-serial'];
                const apiV3Key = process.env.WX_API_V3_KEY;

                const isValid = await this.wechatpay.verifySign({
                    timestamp,
                    nonce,
                    body,
                    serial: serialNo,
                    signature,
                    apiSecret: apiV3Key,
                });

                if (!isValid) {
                    throw new BadRequestException('回调签名验证失败');
                }

                // 解密回调数据（resource 包含 ciphertext/associated_data/nonce）
                const decryptedData = this.wechatpay.decipher_gcm(
                    resource.ciphertext,
                    resource.associated_data,
                    resource.nonce,
                    apiV3Key,
                );
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
            const result = await this.wechatpay.refunds({
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
            const result = await this.wechatpay.query({ out_trade_no: outTradeNo });
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
    async verifyCallback(body: any, signature: string, timestamp: string, nonce: string, serialNo: string): Promise<boolean> {
        if (!this.wechatpay) {
            return false;
        }

        try {
            return await this.wechatpay.verifySign({
                timestamp,
                nonce,
                body,
                serial: serialNo,
                signature,
                apiSecret: process.env.WX_API_V3_KEY,
            });
        } catch (error) {
            this.logger.error('验证回调签名失败', error);
            return false;
        }
    }

    decryptResource(resource: any): any {
        if (!this.wechatpay) {
            throw new BadRequestException('微信支付客户端未初始化');
        }

        try {
            return this.wechatpay.decipher_gcm(
                resource.ciphertext,
                resource.associated_data,
                resource.nonce,
                process.env.WX_API_V3_KEY,
            );
        } catch (error) {
            this.logger.error('解密回调数据失败', error);
            throw new BadRequestException('解密回调数据失败');
        }
    }

    /**
     * 处理支付成功回调，更新订单支付状态
     * @param outTradeNo 商户订单号
     * @param transactionId 微信支付订单号
     * @param status 微信返回的支付状态
     */
    async handlePaymentSuccess(outTradeNo: string, transactionId: string): Promise<void> {
        // 支付成功：paymentStatus → PAID，bookingStatus → CONFIRMED（预约正式生效）
        await this.bookingRepository
            .createQueryBuilder()
            .update(Booking)
            .set({
                paymentStatus: PaymentStatus.PAID,
                status: BookingStatus.CONFIRMED,
                transactionId,
                paidAt: new Date(),
            })
            .where('outTradeNo = :outTradeNo', { outTradeNo })
            .execute();
    }

    /**
     * 处理退款回调，更新订单退款状态
     * @param outTradeNo 商户订单号
     * @param refundStatus 微信返回的退款状态
     */
    async handleRefundCallback(outTradeNo: string, refundStatus: string): Promise<void> {
        if (refundStatus === 'SUCCESS') {
            await this.bookingRepository
                .createQueryBuilder()
                .update(Booking)
                .set({
                    refundStatus: RefundStatus.REFUNDED,
                    status: BookingStatus.REFUNDED,
                    refundedAt: new Date(),
                })
                .where('outTradeNo = :outTradeNo', { outTradeNo })
                .execute();
        } else if (refundStatus === 'FAILED') {
            // 退款失败：refundStatus → FAILED，paymentStatus → FAILED
            await this.bookingRepository
                .createQueryBuilder()
                .update(Booking)
                .set({
                    refundStatus: RefundStatus.FAILED,
                    paymentStatus: PaymentStatus.FAILED,
                })
                .where('outTradeNo = :outTradeNo', { outTradeNo })
                .execute();
        }
    }
}
