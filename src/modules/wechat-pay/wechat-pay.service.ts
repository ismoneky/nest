import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Booking, BookingStatus, PaymentStatus, RefundStatus } from '../../entities/booking.entity';
import { AnomalyType } from '../../entities/booking-anomaly.entity';
import { BookingRepository } from '../../repositories/booking.repository';
import { readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID, createSign, createVerify, createDecipheriv } from 'crypto';
import * as https from 'https';

/**
 * 微信支付参数（前端调起支付），接口文档「支付 single-flight」定义
 */
export type PaymentParams = {
    outTradeNo: string;
    appId: string;
    timeStamp: string;
    nonceStr: string;
    package: string;
    signType: 'RSA';
    paySign: string;
};

/**
 * 微信支付请求失败错误（稳定错误码，供调用方分类）
 */
export class PaymentRequestError extends Error {
    constructor(public readonly code: string, message?: string) {
        super(message ?? code);
        this.name = 'PaymentRequestError';
    }
}

/**
 * 微信支付 API 返回非 2xx 的错误（保留状态码与响应体，供 closeOrder/queryOrder 分类）
 */
export class WechatApiError extends Error {
    constructor(
        public readonly statusCode: number,
        public readonly body: any,
        message: string,
    ) {
        super(message);
        this.name = 'WechatApiError';
    }
}

/**
 * closeOrder 结构化结果
 */
export type CloseOrderResultKind = 'CLOSED' | 'ALREADY_CLOSED' | 'ALREADY_PAID' | 'UNKNOWN';
export interface CloseOrderResult {
    kind: CloseOrderResultKind;
    /** UNKNOWN 时附带稳定错误码，供日志和异常通道使用 */
    errorCode?: string;
}

/**
 * queryOrder 结构化结果：区分明确终态 / 处理中 / 未知，不抛异常，由调用方判断
 */
export type OrderQueryState =
    | 'SUCCESS' // 支付成功（终态）
    | 'CLOSED' // 已关闭（终态）
    | 'REVOKED' // 已撤销（终态）
    | 'PAYERROR' // 支付失败（终态）
    | 'REFUND' // 已转入退款（终态）
    | 'NOTPAY' // 未支付（处理中，可关单换单）
    | 'USERPAYING' // 用户支付中（处理中，不可关单，见待确认问题 2）
    | 'NOT_EXIST' // 微信侧明确不存在（允许换单；PAYING 时记 REMOTE_ORDER_NOT_FOUND 异常）
    | 'UNKNOWN'; // 网络错误/超时/解析失败
export interface OrderQueryResult {
    state: OrderQueryState;
    /** 微信原文 trade_state */
    tradeState?: string;
    transactionId?: string;
    errorCode?: string;
}

/**
 * queryRefund 结构化结果
 */
export type RefundQueryState = 'SUCCESS' | 'PROCESSING' | 'CLOSED' | 'ABNORMAL' | 'NOT_EXIST' | 'UNKNOWN';
export interface RefundQueryResult {
    state: RefundQueryState;
    refundStatus?: string;
    errorCode?: string;
}

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

    // 用户交互 Agent：用户发起支付、用户重试时关闭旧单、申请退款使用。
    // 保留 keep-alive，maxSockets=5，与后台对账 Agent 隔离，避免被后台任务占满 socket。
    readonly interactiveAgent = new https.Agent({
        keepAlive: true,
        maxSockets: 5,
        maxFreeSockets: 2,
        timeout: 10000,
    });

    // 后台对账 Agent：支付查询、退款查询和超时关单使用。
    // 独立 keep-alive 池，maxSockets=2，后台整体最多两个微信请求。
    readonly reconciliationAgent = new https.Agent({
        keepAlive: true,
        maxSockets: 2,
        maxFreeSockets: 1,
        timeout: 10000,
    });

    constructor(
        @InjectRepository(Booking)
        private readonly bookingRepository: Repository<Booking>,
        private readonly bookingRepo: BookingRepository,
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
        return 'https://hbfctl.com.cn/api';
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
     * @param signal 可选 AbortSignal（single-flight 22 秒整体预算使用）
     * @param agent 使用的 HTTPS Agent（交互/对账隔离）
     */
    private request<T = any>(
        method: 'GET' | 'POST',
        path: string,
        body?: object,
        opts?: { signal?: AbortSignal; agent?: https.Agent },
    ): Promise<T> {
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
                    'User-agent': `Node.js/${process.version}`
                },
                agent: opts?.agent ?? this.interactiveAgent,
            };

            // AbortSignal：deadline 到达时 controller.abort() 会销毁 request
            if (opts?.signal) {
                options.signal = opts.signal;
            }

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
                        // 非 2xx：保留状态码与响应体，供 closeOrder/queryOrder 分类
                        let parsed: any = null;
                        try {
                            parsed = data ? JSON.parse(data) : null;
                        } catch {
                            parsed = null;
                        }
                        reject(new WechatApiError(res.statusCode ?? 0, parsed, `微信支付 API 错误 [${res.statusCode}] ${method} ${path}: ${data}`));
                    }
                });
            });

            req.on('error', (err) => {
                // abort（22 秒预算超时）统一转换为稳定错误 PAYMENT_PREPARATION_TIMEOUT
                if (opts?.signal?.aborted) {
                    reject(new PaymentRequestError('PAYMENT_PREPARATION_TIMEOUT', `微信支付请求已中止: ${method} ${path}`));
                } else {
                    reject(err);
                }
            });
            req.setTimeout(10000, () => {
                req.destroy(new PaymentRequestError('PAYMENT_PREPARATION_TIMEOUT', `微信支付请求超时: ${method} ${path}`));
            });

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
     * outTradeNo 由 Booking Service 经 markPaymentStarting 落库后传入，本方法不再自行生成单号。
     */
    async createPayment(outTradeNo: string, amount: number, description: string, openid: string, paymentExpiredAt: Date, signal?: AbortSignal): Promise<PaymentParams> {
        this.assertInitialized();

        const notifyUrl = `${this.getApiBaseUrl()}/wechat-pay/notify`;

        // time_expire 格式：yyyy-MM-DDTHH:mm:ss+08:00（rfc3339，东八区）
        // toISOString() 是 UTC 时间，需先加 8 小时再格式化，不能直接替换 Z
        const bjTime = new Date(paymentExpiredAt.getTime() + 8 * 60 * 60 * 1000);
        const timeExpire = bjTime.toISOString().replace('Z', '+08:00').split('.')[0] + '+08:00';

        const result = await this.request<{ prepay_id: string }>(
            'POST',
            '/v3/pay/transactions/jsapi',
            {
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
            },
            { signal, agent: this.interactiveAgent },
        );

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
     * 关闭订单（结构化结果，不再吞错误）
     * 官方文档：POST /v3/pay/transactions/out-trade-no/{out_trade_no}/close
     * @param agent 交互（用户重试）传 interactiveAgent；后台超时关单传 reconciliationAgent
     * @returns CLOSED / ALREADY_CLOSED / ALREADY_PAID / UNKNOWN；只有明确终态才返回前三类
     */
    async closeOrder(outTradeNo: string, opts?: { signal?: AbortSignal; agent?: https.Agent }): Promise<CloseOrderResult> {
        this.assertInitialized();

        try {
            await this.request(
                'POST',
                `/v3/pay/transactions/out-trade-no/${outTradeNo}/close`,
                { mchid: this.mchid },
                { signal: opts?.signal, agent: opts?.agent ?? this.interactiveAgent },
            );
            this.logger.log(`关闭微信订单成功: ${outTradeNo}`);
            return { kind: 'CLOSED' };
        } catch (error) {
            if (error instanceof PaymentRequestError) {
                this.logger.warn(`关闭微信订单结果未知: ${outTradeNo}, code=${error.code}`);
                return { kind: 'UNKNOWN', errorCode: error.code === 'PAYMENT_PREPARATION_TIMEOUT' ? 'PAYMENT_PREPARATION_TIMEOUT' : 'CLOSE_ORDER_UNKNOWN' };
            }
            if (error instanceof WechatApiError) {
                const code = error.body?.code;
                if (code === 'ORDER_PAID') {
                    this.logger.warn(`关闭微信订单发现已支付: ${outTradeNo}`);
                    return { kind: 'ALREADY_PAID' };
                }
                if (code === 'ORDER_CLOSED' || code === 'ORDER_NOT_EXIST') {
                    this.logger.log(`关闭微信订单已关闭或不存在: ${outTradeNo}, code=${code}`);
                    return { kind: 'ALREADY_CLOSED' };
                }
                this.logger.warn(`关闭微信订单失败（业务拒绝）: ${outTradeNo}, code=${code ?? error.statusCode}`);
                return { kind: 'UNKNOWN', errorCode: 'CLOSE_ORDER_UNKNOWN' };
            }
            this.logger.warn(`关闭微信订单失败: ${outTradeNo}`, error?.message);
            return { kind: 'UNKNOWN', errorCode: 'CLOSE_ORDER_UNKNOWN' };
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
     * 按商户订单号查询微信侧订单（后台对账用，不使用交互 Agent）
     * 官方文档：GET /v3/pay/transactions/out-trade-no/{out_trade_no}?mchid={mchid}
     * 返回结构化结果，不抛异常
     */
    async queryOrder(outTradeNo: string, opts?: { agent?: https.Agent; signal?: AbortSignal }): Promise<OrderQueryResult> {
        this.assertInitialized();

        try {
            const data = await this.request<any>(
                'GET',
                `/v3/pay/transactions/out-trade-no/${outTradeNo}?mchid=${this.mchid}`,
                undefined,
                { agent: opts?.agent ?? this.reconciliationAgent, signal: opts?.signal },
            );
            const state = this.mapTradeState(data.trade_state);
            return { state, tradeState: data.trade_state, transactionId: data.transaction_id };
        } catch (error) {
            if (error instanceof WechatApiError && error.statusCode === 404) {
                return { state: 'NOT_EXIST', errorCode: 'ORDER_NOT_EXIST' };
            }
            this.logger.error(`查询订单状态失败: ${outTradeNo}`, error?.message);
            return { state: 'UNKNOWN', errorCode: 'QUERY_ORDER_UNKNOWN' };
        }
    }

    /**
     * 按微信支付订单号查询微信侧订单（仅支付成功后可用）
     * 官方文档：GET /v3/pay/transactions/id/{transaction_id}?mchid={mchid}
     */
    async queryOrderByTransactionId(transactionId: string) {
        this.assertInitialized();

        try {
            return await this.request('GET', `/v3/pay/transactions/id/${transactionId}?mchid=${this.mchid}`, undefined, {
                agent: this.reconciliationAgent,
            });
        } catch (error) {
            this.logger.error('按微信订单号查询失败', error);
            throw new BadRequestException('查询订单状态失败');
        }
    }

    /**
     * 查询退款状态（后台对账用）
     * 官方文档：GET /v3/refund/domestic/refunds/{out_refund_no}
     * 返回结构化结果，不抛异常
     */
    async queryRefund(outRefundNo: string): Promise<RefundQueryResult> {
        this.assertInitialized();

        try {
            const data = await this.request<any>(
                'GET',
                `/v3/refund/domestic/refunds/${outRefundNo}`,
                undefined,
                { agent: this.reconciliationAgent },
            );
            const status = data.refund_status;
            const state: RefundQueryState =
                status === 'SUCCESS' || status === 'PROCESSING' || status === 'CLOSED' || status === 'ABNORMAL'
                    ? status
                    : 'UNKNOWN';
            return { state, refundStatus: status };
        } catch (error) {
            if (error instanceof WechatApiError && error.statusCode === 404) {
                return { state: 'NOT_EXIST', errorCode: 'RESOURCE_NOT_EXISTS' };
            }
            this.logger.error(`查询退款状态失败: ${outRefundNo}`, error?.message);
            return { state: 'UNKNOWN', errorCode: 'QUERY_REFUND_UNKNOWN' };
        }
    }

    /**
     * 申请退款（用户主动发起，使用交互 Agent）
     * 官方文档：POST /v3/refund/domestic/refunds
     */
    async refund(outTradeNo: string, outRefundNo: string, totalAmount: number, refundAmount: number) {
        this.assertInitialized();

        try {
            return await this.request(
                'POST',
                '/v3/refund/domestic/refunds',
                {
                    out_trade_no: outTradeNo,
                    out_refund_no: outRefundNo,
                    notify_url: `${this.getApiBaseUrl()}/wechat-pay/refund-notify`,
                    amount: {
                        refund: refundAmount,
                        total: totalAmount,
                        currency: 'CNY',
                    },
                },
                { agent: this.interactiveAgent },
            );
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
     * 支付成功后更新本地订单状态（幂等：仅对非支付终态执行，清空调度字段）
     * 等价于转换协议 markPaymentSucceeded，条件更新失败（affected=0）表示已被其他流程推进，忽略。
     * 回调为最高优先级确认：成功后自动 RESOLVED 支付相关 OPEN 异常（PAYMENT_QUERY_REPEATED_FAILURE、
     * REMOTE_ORDER_NOT_FOUND、PAYMENT_CREATED_LOCAL_SAVE_FAILED），与对账/异常通道路径一致。
     */
    async handlePaymentSuccess(outTradeNo: string, transactionId: string): Promise<void> {
        await this.bookingRepo.markPaymentSucceeded(outTradeNo, transactionId, new Date());
        // 按订单号反查 bookingId 后 RESOLVED 支付相关异常（条件 UPDATE，affected=0 无副作用）
        try {
            const booking = await this.bookingRepo.getBookingByOutTradeNo(outTradeNo);
            const now = Date.now();
            for (const type of [
                AnomalyType.PAYMENT_QUERY_REPEATED_FAILURE,
                AnomalyType.REMOTE_ORDER_NOT_FOUND,
                AnomalyType.PAYMENT_CREATED_LOCAL_SAVE_FAILED,
            ]) {
                await this.bookingRepo.resolveAnomaly(booking.bookingId, type, '支付成功回调确认', now);
            }
        } catch {
            // 订单不存在等异常不影响已完成的 markPaymentSucceeded
        }
    }

    /**
     * 退款回调后更新本地退款状态（幂等）
     * 成功/终态失败后自动 RESOLVED 退款相关 OPEN 异常（REFUND_QUERY_REPEATED_FAILURE），
     * 与退款对账路径一致。
     */
    async handleRefundCallback(outTradeNo: string, refundStatus: string): Promise<void> {
        let booking: Booking;
        try {
            booking = await this.bookingRepo.getBookingByOutTradeNo(outTradeNo);
        } catch {
            return; // 订单不存在，幂等忽略
        }

        const now = Date.now();
        if (refundStatus === 'SUCCESS') {
            await this.bookingRepo.markRefundSucceeded(booking.bookingId, booking.outRefundNo, new Date());
            await this.bookingRepo.resolveAnomaly(booking.bookingId, AnomalyType.REFUND_QUERY_REPEATED_FAILURE, '退款成功回调确认', now);
        } else if (refundStatus === 'ABNORMAL' || refundStatus === 'CLOSED') {
            await this.bookingRepo.markRefundFailed(booking.bookingId, booking.outRefundNo);
            await this.bookingRepo.resolveAnomaly(booking.bookingId, AnomalyType.REFUND_QUERY_REPEATED_FAILURE, '退款回调确认终态失败', now);
        }
    }

    /**
     * 微信 trade_state → 结构化 state 分类
     */
    private mapTradeState(tradeState: string): OrderQueryState {
        switch (tradeState) {
            case 'SUCCESS':
                return 'SUCCESS';
            case 'CLOSED':
                return 'CLOSED';
            case 'REVOKED':
                return 'REVOKED';
            case 'PAYERROR':
                return 'PAYERROR';
            case 'REFUND':
                return 'REFUND';
            case 'NOTPAY':
                return 'NOTPAY';
            case 'USERPAYING':
                return 'USERPAYING';
            default:
                return 'UNKNOWN';
        }
    }
}
