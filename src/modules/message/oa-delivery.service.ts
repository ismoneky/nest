import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Message, OaSendStatus } from '../../entities/message.entity';
import { WechatOaConfig } from '../wechat-oa/wechat-oa.config';
import { WechatOaClient } from '../wechat-oa/wechat-oa.client';
import { WechatOaRepository } from '../../repositories/wechat-oa.repository';
import { OaDeliveryRepository, OaSettlement } from '../../repositories/oa-delivery.repository';
import { parseOaSnapshot } from './oa-message-policy';

@Injectable()
export class OaDeliveryService {
    private running = false;
    private readonly logger = new Logger(OaDeliveryService.name);
    constructor(private readonly config: WechatOaConfig, private readonly repo: OaDeliveryRepository,
        private readonly fans: WechatOaRepository, private readonly api: WechatOaClient) {}

    @Cron('17 * * * * *', { timeZone: 'Asia/Shanghai' })
    async run(): Promise<void> {
        if (this.running || !this.config.sendEnabled || !this.config.workerEnabled || !this.config.credentialsReady()) return;
        this.running = true;
        const startedAt = Date.now();
        try {
            await this.repo.recoverInterrupted(startedAt);
            const batch = await this.repo.due(startedAt);
            let index = 0;
            const consume = async () => {
                while (index < batch.length && Date.now() - startedAt < 60000) {
                    const message = batch[index++];
                    await this.deliver(message);
                }
            };
            // 一条领取失败也要等另一条在途投递结束，才能释放本轮重入锁。
            const results = await Promise.allSettled([consume(), consume()]);
            if (results.some(result => result.status === 'rejected')) this.logger.error('OA_WORKER_STORAGE_ERROR');
        } catch { this.logger.error('OA_WORKER_STORAGE_ERROR'); }
        finally { this.running = false; }
    }

    private async deliver(message: Message): Promise<void> {
        const claimedAt = Date.now();
        if (!await this.repo.claim(message.id, claimedAt)) return;
        let attempted = false;
        const settle = async (patch: OaSettlement) => {
            // 微信成功后的写库重试只重复本地更新，不重新调用发送接口。
            for (let i = 0; i < 3; i++) {
                try { await this.repo.settle(message.id, claimedAt, patch); return; }
                catch { if (i === 2) throw new Error('OA_SETTLEMENT_FAILED'); }
            }
        };
        const skip = (reason: string) => settle({ oaSendStatus: OaSendStatus.SKIPPED, oaSkipReason: reason });
        try {
            if (!message.oaExpiresAt || message.oaExpiresAt <= Date.now()) { await skip('EXPIRED'); return; }
            const payload = parseOaSnapshot(message.oaPayloadJson, this.config);
            if (!payload) { await skip('SNAPSHOT_INVALID'); return; }
            const recipient = await this.fans.resolveRecipient(message.userId, this.config.appId);
            if (recipient.kind === 'waiting') {
                await settle({ oaSendStatus: OaSendStatus.PENDING, oaNextAttemptAt: Math.min(Date.now() + 600000, message.oaExpiresAt), oaLastError: 'IDENTITY_PENDING' });
                return;
            }
            if (recipient.kind !== 'ready') { await skip(recipient.kind === 'unsubscribed' ? 'NOT_SUBSCRIBED' : 'IDENTITY_CONFLICT'); return; }
            let token = await this.api.getAccessToken(), refreshed = false;
            while (message.oaAttempts < 3) {
                if (message.oaExpiresAt <= Date.now()) { await skip('EXPIRED'); return; }
                if (!await this.repo.recordAttempt(message.id, claimedAt)) { await skip('ATTEMPT_NOT_CLAIMED'); return; }
                attempted = true; message.oaAttempts++;
                const outcome = await this.api.sendTemplate({ ...payload, touser: recipient.openid }, token);
                if (outcome.kind === 'accepted') {
                    await settle({ oaSendStatus: OaSendStatus.SENT, oaMsgId: outcome.msgId }); return;
                }
                if (outcome.kind === 'unknown') {
                    await settle({ oaSendStatus: OaSendStatus.UNKNOWN, oaLastError: String(outcome.code) }); return;
                }
                // 以下都是微信明确拒绝，可以确定本次未受理。
                attempted = false;
                if (outcome.kind === 'not_subscribed') {
                    await this.fans.markUnsubscribed(this.config.appId, recipient.openid, Date.now());
                    await skip('NOT_SUBSCRIBED'); return;
                }
                if (outcome.kind === 'token' && !refreshed && message.oaAttempts < 3) {
                    refreshed = true; this.api.invalidateToken(token); token = await this.api.getAccessToken(); continue;
                }
                if ((outcome.kind === 'retryable' || outcome.kind === 'rate_limit') && message.oaAttempts < 3) {
                    const delay = outcome.kind === 'rate_limit' ? 3600000 : message.oaAttempts === 1 ? 60000 : 300000;
                    await settle({ oaSendStatus: OaSendStatus.PENDING, oaNextAttemptAt: Math.min(Date.now() + delay, message.oaExpiresAt), oaLastError: String(outcome.code) });
                } else {
                    await settle({ oaSendStatus: OaSendStatus.FAILED, oaLastError: String(outcome.code) });
                    this.logger.warn(`OA_SEND_FAILED messageId=${message.id} code=${outcome.code}`);
                }
                return;
            }
            await settle({ oaSendStatus: OaSendStatus.FAILED, oaLastError: 'ATTEMPTS_EXHAUSTED' });
        } catch {
            this.logger.error(`OA_DELIVERY_ERROR messageId=${message.id}`);
            try {
                await settle(attempted ? { oaSendStatus: OaSendStatus.UNKNOWN, oaLastError: 'RESULT_UNCERTAIN' }
                    : { oaSendStatus: OaSendStatus.PENDING, oaNextAttemptAt: Math.min(Date.now() + 600000, message.oaExpiresAt || Date.now()), oaLastError: 'PRE_SEND_ERROR' });
            } catch { this.logger.error(`OA_SETTLEMENT_FAILED messageId=${message.id}：等待过期领取恢复`); }
        }
    }
}
