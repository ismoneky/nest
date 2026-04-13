import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Booking, BookingStatus, PaymentStatus, RefundStatus } from '../../entities/booking.entity';
import { readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID, createSign, createVerify, createDecipheriv } from 'crypto';
import * as https from 'https';

/**
 * 微信支付服务
 * 直接调用微信支付 APIv3，使用 WECHATPAY2-SHA256-RSA2048 签名认证
 * 不依赖第三方 npm 包
 */
@Injectable()
export class WechatPayService {
    private readonly logger = new Logger(WechatPayService.name);

    private appid: string;
    private mchid: string;
    private serialNo: string;       // 商户 API 证书序列号
    private privateKey: Buffer;     // 商户 API 证书私钥（用于请求签名）
    private publicKeyId: string;    // 微信支付公钥 ID（Wechatpay-Serial 请求头）
    private publicKey: Buffer;      // 微信支付公钥（用于验证回调签名）
    private apiV3Key: string;       // APIv3 密钥（用于 AES-GCM 解密回调数据）
    private initialized = false;

    constructor(
        @InjectRepository(Booking)
        private readonly bookingRepository: Repository<Booking>,
    ) {
        this.init();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 初始化
    // ─────────────────────────────────────────────────────────────────────────

    private init() {
        try {
            const appid          = process.env.WX_APPID;
            const mchid          = process.env.WX_MCHID;
            const privateKeyPath = process.env.WX_PRIVATE_KEY_PATH;
            const serialNo       = process.env.WX_SERIAL_NO;
            const apiV3Key       = process.env.WX_API_V3_KEY;
            const publicKeyPath  = process.env.WX_PUBLIC_KEY_PATH;
            const publicKeyId    = process.env.WX_PUBLIC_KEY_ID;

            if (!appid || !mchid || !privateKeyPath || !serialNo || !apiV3Key || !publicKeyPath || !publicKeyId) {
                this.logger.error('微信支付配置不完整，请检查环境变量：WX_APPID / WX_MCHID / WX_PRIVATE_KEY_PATH / WX_SERIAL_NO / WX_API_V3_KEY / WX_PUBLIC_KEY_PATH / WX_PUBLIC_KEY_ID');
                return;
            }

            this.appid       = appid;
            this.mchid       = mchid;
            this.serialNo    = serialNo;
            this.apiV3Key    = apiV3Key;
            this.publicKeyId = publicKeyId;
            this.privateKey  = readFileSync(join(process.cwd(), privateKeyPath));
            this.publicKey   = readFileSync(join(process.cwd(), publicKeyPath));
            this.initialized = true;

            this.logger.log('微信支付初始化成功');
        } catch (error) {
            this.logger.error('微信支付初始化失败', error);
        }
    }

    private assertInitialized() {
        if (!this.initialized) {
            throw new BadRequestException('微信支付未初始化，请检查配置');
        }
    }

    private getApiBaseUrl(): string {
        const protocol = process.env.API_PROTOCOL || 'http';
        const host     = process.env.API_HOST || 'localhost';
        const port     = process.env.PORT || '3000';
        const isDefaultPort =
            (protocol === 'https' && port === '443') ||
            (protocol === 'http'  && port === '80');
        return isDefaultPort ? `${protocol}://${host}` : `${protocol}://${host}:${port}`;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 签名 / 验签 / 解密（均使用 Node.js 内置 crypto）
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * 生成请求签名，构造 Authorization 头
     * 格式：WECHATPAY2-SHA256-RSA2048 mchid="...",nonce_str="...",timestamp="...",serial_no="...",signature="..."
     */
    private buildAuthorization(method: string, urlPath: string, body: string): string {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const nonceStr = randomUUID().replace(/-/g, '');

        // 签名串：HTTP方法\n URL\n 时间戳\n 随机串\n 请求体\n
        const message = `${method}\n${urlPath}\n${timestamp}\n${nonceStr}\n${body}\n`;
        const signature = createSign('RSA-SHA256')
            .update(message)
            .sign(this.privateKey, 'base64');

        return `WECHATPAY2-SHA256-RSA2048 mchid="${this.mchid}",nonce_str="${nonceStr}",timestamp="${timestamp}",serial_no="${this.serialNo}",signature="${signature}"`;
    }

    /**
     * 验证微信回调签名
     * 签名串：时间戳\n 随机串\n 请求体\n
     */
    private verifySignature(timestamp: string, nonce: string, body: string, signature: string): boolean {
        try {
            const message = `${timestamp}\n${nonce}\n${body}\n`;
            return createVerify('RSA-SHA256')
                .update(message)
                .verify(this.publicKey, signature, 'base64');
        } catch {
            return false;
        }
    }

    /**
     * AES-256-GCM 解密微信回调 resource 数据
     */
    private decryptAesGcm(ciphertext: string, associatedData: string, nonce: string): any {
        const key = Buffer.from(this.apiV3Key, 'utf8');       // 32 字节
        const iv = Buffer.from(nonce, 'utf8');               // 12 字节
        const cipherBuf = Buffer.from(ciphertext, 'base64');
        // 微信将 16 字节 authTag 附在密文末尾
        const authTag = cipherBuf.slice(cipherBuf.length - 16);
        const encrypted = cipherBuf.slice(0, cipherBuf.length - 16);

        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);
        decipher.setAAD(Buffer.from(associatedData, 'utf8'));

        const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
        return JSON.parse(decrypted.toString('utf8'));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // HTTP 请求工具
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * 发送微信支付 APIv3 请求
     */
    private request<T = any>(method: 'GET' | 'POST', path: string, body?: object): Promise<T> {
        return new Promise((resolve, reject) => {
            const bodyStr = body ? JSON.stringify(body) : '';
            const authorization = this.buildAuthorization(method, path, bodyStr);

            const options: https.RequestOptions = {
                hostname: 'api.mch.weixin.qq.com',
                path,
                method,
                headers: {
                    'Authorization': authorization,
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                },
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            resolve(data ? JSON.parse(data) : ({} as T));
                        } catch {
                            resolve(data as any);
                        }
                    } else {
                        reject(new Error(`微信支付 API 错误 [${res.statusCode}]: ${data}`));
                    }
                });
            });

            req.on('error', reject);

            if (bodyStr) {
                req.write(bodyStr);
            }
            req.end();
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 业务方法
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * JSAPI 小程序下单，返回前端调起支付所需参数
     * 官方文档：POST /v3/pay/transactions/jsapi
     */
    async createPayment(bookingId: string, amount: number, description: string, openid: string, paymentExpiredAt: Date) {
        this.assertInitialized();

        // out_trade_no 直接使用 bookingId（TL + 11位大写字母数字，满足微信6-32位要求）
        // 关单后可重新以同一 outTradeNo 下单，回调时也可直接通过 outTradeNo 定位订单
        const outTradeNo = bookingId;
        const notifyUrl = `${this.getApiBaseUrl()}/wechat-pay/notify`;

        // time_expire 格式：yyyy-MM-DDTHH:mm:ss+08:00（rfc3339，东八区）
        const timeExpire = paymentExpiredAt.toISOString().replace('Z', '+08:00');

        const result = await this.request<{ prepay_id: string }>('POST', '/v3/pay/transactions/jsapi', {
            appid: this.appid,
            mchid: this.mchid,
            description,
            out_trade_no: outTradeNo,
            notify_url: notifyUrl,
            time_expire: timeExpire,
            amount: {
                total: amount,
                currency: 'CNY',
            },
            payer: { openid },
        });

        const prepayId = result.prepay_id;
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const nonceStr = randomUUID().replace(/-/g, '');

        // 调起支付签名串：appId\ntimeStamp\nnonceStr\npackage\n
        const signMessage = `${this.appid}\n${timestamp}\n${nonceStr}\nprepay_id=${prepayId}\n`;
        const paySign = createSign('RSA-SHA256')
            .update(signMessage)
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
    }

    /**
     * 关闭订单
     * 官方文档：POST /v3/pay/transactions/out-trade-no/{out_trade_no}/close
     * 超时或重新下单前必须先关闭旧订单
     */
    async closeOrder(outTradeNo: string): Promise<void> {
        this.assertInitialized();

        try {
            await this.request('POST', `/v3/pay/transactions/out-trade-no/${outTradeNo}/close`, {
                mchid: this.mchid,
            });
            this.logger.log(`关闭微信订单成功: ${outTradeNo}`);
        } catch (error) {
            // 订单已关闭或已支付时微信返回错误，不阻断业务流程
            this.logger.warn(`关闭微信订单失败（可能已关闭或已支付）: ${outTradeNo}`, error?.message);
        }
    }

    /**
     * 查询本地订单支付状态（前端轮询用）
     * 直接读数据库，不请求微信 API
     */
    async getLocalPaymentStatus(outTradeNo: string) {
        const booking = await this.bookingRepository.findOne({
            where: { outTradeNo },
            select: ['outTradeNo', 'transactionId', 'paymentStatus', 'status', 'paidAt'],
        });

        if (!booking) {
            throw new BadRequestException('订单不存在');
        }

        return booking;
    }

    /**
     * 按商户订单号查询微信侧订单（兜底用，不建议频繁调用）
     * 官方文档：GET /v3/pay/transactions/out-trade-no/{out_trade_no}?mchid={mchid}
     */
    async queryOrder(outTradeNo: string) {
        this.assertInitialized();

        try {
            return await this.request('GET', `/v3/pay/transactions/out-trade-no/${outTradeNo}?mchid=${this.mchid}`);
        } catch (error) {
            this.logger.error('查询订单状态失败', error);
            throw new BadRequestException('查询订单状态失败');
        }
    }

    /**
     * 按微信支付订单号查询微信侧订单（兜底用，仅支付成功后可用）
     * 官方文档：GET /v3/pay/transactions/id/{transaction_id}?mchid={mchid}
     */
    async queryOrderByTransactionId(transactionId: string) {
        this.assertInitialized();

        try {
            return await this.request('GET', `/v3/pay/transactions/id/${transactionId}?mchid=${this.mchid}`);
        } catch (error) {
            this.logger.error('按微信订单号查询失败', error);
            throw new BadRequestException('查询订单状态失败');
        }
    }

    /**
     * 申请退款
     * 官方文档：POST /v3/refund/domestic/refunds
     */
    async refund(outTradeNo: string, outRefundNo: string, totalAmount: number, refundAmount: number) {
        this.assertInitialized();

        try {
            return await this.request('POST', '/v3/refund/domestic/refunds', {
                out_trade_no: outTradeNo,
                out_refund_no: outRefundNo,
                notify_url: `${this.getApiBaseUrl()}/wechat-pay/refund-notify`,
                amount: {
                    refund: refundAmount,
                    total: totalAmount,
                    currency: 'CNY',
                },
            });
        } catch (error) {
            this.logger.error('申请退款失败', error);
            throw new BadRequestException('申请退款失败');
        }
    }

    /**
     * 验证支付回调签名（使用原始请求体）
     * 需在应答前调用，5s 内完成
     */
    verifyPaymentNotify(rawBody: string, headers: any): { valid: boolean; reason?: string } {
        if (!this.initialized) {
            return { valid: false, reason: '微信支付未初始化' };
        }

        const signature = headers['wechatpay-signature'];
        const timestamp = headers['wechatpay-timestamp'];
        const nonce     = headers['wechatpay-nonce'];

        if (!signature || !timestamp || !nonce) {
            return { valid: false, reason: '缺少签名请求头' };
        }

        // 微信签名探测流量：以 WECHATPAY/SIGNTEST/ 开头，直接拒绝
        if (signature.startsWith('WECHATPAY/SIGNTEST/')) {
            return { valid: false, reason: '签名探测流量' };
        }

        const ok = this.verifySignature(timestamp, nonce, rawBody, signature);
        return ok ? { valid: true } : { valid: false, reason: '签名验证失败' };
    }

    /**
     * 解析支付回调 body，解密并返回订单信息
     * 仅在验签通过后调用
     */
    parsePaymentNotify(body: any): { outTradeNo: string; transactionId: string; status: string; openid: string } | null {
        const { resource, event_type } = body;

        if (event_type !== 'TRANSACTION.SUCCESS') {
            return null;
        }

        const decryptedData = this.decryptAesGcm(
            resource.ciphertext,
            resource.associated_data,
            resource.nonce,
        );

        const { out_trade_no, transaction_id, trade_state, payer } = decryptedData;

        return {
            outTradeNo:    out_trade_no,
            transactionId: transaction_id,
            status:        trade_state,
            openid:        payer?.openid,
        };
    }

    /**
     * 解析退款回调 body，解密并返回退款信息
     * 仅在验签通过后调用（验签复用 verifyPaymentNotify）
     */
    parseRefundNotify(body: any): { outTradeNo: string; refundStatus: string } | null {
        const { resource, event_type } = body;

        if (event_type !== 'REFUND.SUCCESS' && event_type !== 'REFUND.ABNORMAL' && event_type !== 'REFUND.CLOSED') {
            return null;
        }

        const decryptedData = this.decryptAesGcm(
            resource.ciphertext,
            resource.associated_data,
            resource.nonce,
        );

        const { out_trade_no, refund_status } = decryptedData;

        return { outTradeNo: out_trade_no, refundStatus: refund_status };
    }

    /**
     * 支付成功后更新本地订单状态
     * 幂等：仅对 PAYING 状态的订单执行更新
     */
    async handlePaymentSuccess(outTradeNo: string, transactionId: string): Promise<void> {
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
            .andWhere('paymentStatus = :paymentStatus', { paymentStatus: PaymentStatus.PAYING })
            .execute();
    }

    /**
     * 退款回调后更新本地退款状态
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
        } else if (refundStatus === 'ABNORMAL' || refundStatus === 'CLOSED') {
            // 退款失败：refundStatus → FAILED，paymentStatus 保持 PAID
            await this.bookingRepository
                .createQueryBuilder()
                .update(Booking)
                .set({ refundStatus: RefundStatus.FAILED })
                .where('outTradeNo = :outTradeNo', { outTradeNo })
                .execute();
        }
    }
}
