import { DataSource } from 'typeorm';
import { Message, MessageType, OaSendStatus } from '../../entities/message.entity';
import { MessageRepository } from '../../repositories/message.repository';
import { OaDeliveryRepository } from '../../repositories/oa-delivery.repository';
import { MessageService } from './message.service';
import { OaDeliveryService } from './oa-delivery.service';
import { WechatOaConfig } from '../wechat-oa/wechat-oa.config';

describe('服务号持久化投递', () => {
    let ds: DataSource, repo: OaDeliveryRepository, service: MessageService, worker: OaDeliveryService;
    let config: WechatOaConfig, recipients: { resolveRecipient: jest.Mock; markUnsubscribed: jest.Mock }, api: any;
    const makeWorker = () => new OaDeliveryService(config, repo, recipients as any, api);
    beforeEach(async () => {
        ds = await new DataSource({ type: 'sqlite', database: ':memory:', entities: [Message], synchronize: true }).initialize();
        config = Object.assign(new WechatOaConfig(), { sendEnabled: true, syncEnabled: true, workerEnabled: true,
            appId: 'wx0123456789abcdef', secret: 'abcdef0123456789abcdef0123456789', miniAppId: 'wxfedcba9876543210',
            templates: { REFUND_SUCCESS: { templateId: 'real-template-test', fields: {
                amount1: { source: 'refundAmount', maxLength: 20 }, character_string2: { source: 'bizNo', maxLength: 32 },
            } } } });
        repo = new OaDeliveryRepository(ds.getRepository(Message));
        service = new MessageService(new MessageRepository(ds.getRepository(Message)), config);
        recipients = { resolveRecipient: jest.fn().mockResolvedValue({ kind: 'ready', openid: 'oa-a' }), markUnsubscribed: jest.fn() };
        api = { getAccessToken: jest.fn().mockResolvedValue('token-a'), invalidateToken: jest.fn(),
            sendTemplate: jest.fn().mockResolvedValue({ kind: 'accepted', msgId: 'msg-123' }) };
        worker = makeWorker();
    });
    afterEach(async () => ds.destroy());
    const send = (bizNo = 'apply-1') => service.send(MessageType.REFUND_SUCCESS,
        { userId: 'mini-a', bookingId: 'booking-1', bizNo, refundAmount: 1201 });
    const row = () => ds.getRepository(Message).findOneBy({ dedupeKey: 'REFUND_SUCCESS:apply-1' });

    it('插入快照不访问微信，重启 worker 后从库发送并记录受理凭证', async () => {
        await send(); await send();
        expect(api.sendTemplate).not.toHaveBeenCalled();
        expect(await ds.getRepository(Message).count()).toBe(1);
        await makeWorker().run();
        const message = await row();
        expect(message.oaSendStatus).toBe(OaSendStatus.SENT);
        expect(message.oaMsgId).toBe('msg-123');
        expect(message.oaAttempts).toBe(1);
        expect(api.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ touser: 'oa-a',
            data: { amount1: { value: '12.01' }, character_string2: { value: 'apply-1' } },
            miniprogram: { appid: config.miniAppId, pagepath: 'pages/index/index' } }), 'token-a');
        await worker.run(); expect(api.sendTemplate).toHaveBeenCalledTimes(1);
    });
    it('缺身份等待，不计发送次数；超过业务有效期跳过', async () => {
        await send(); recipients.resolveRecipient.mockResolvedValue({ kind: 'waiting' });
        await worker.run();
        expect((await row()).oaSendStatus).toBe(OaSendStatus.PENDING);
        expect((await row()).oaAttempts).toBe(0);
        await ds.getRepository(Message).update((await row()).id, { oaExpiresAt: Date.now() - 1, oaNextAttemptAt: 0 });
        await worker.run();
        expect((await row()).oaSkipReason).toBe('EXPIRED');
        expect(api.sendTemplate).not.toHaveBeenCalled();
    });
    it('明确未关注更新粉丝状态并跳过', async () => {
        await send(); api.sendTemplate.mockResolvedValue({ kind: 'not_subscribed', code: 43004 });
        await worker.run();
        expect((await row()).oaSkipReason).toBe('NOT_SUBSCRIBED');
        expect(recipients.markUnsubscribed).toHaveBeenCalledWith(config.appId, 'oa-a', expect.any(Number));
    });
    it('超时记 UNKNOWN，之后不自动重发', async () => {
        await send(); api.sendTemplate.mockResolvedValue({ kind: 'unknown', code: 'TRANSPORT' });
        await worker.run(); await worker.run();
        expect((await row()).oaSendStatus).toBe(OaSendStatus.UNKNOWN);
        expect(api.sendTemplate).toHaveBeenCalledTimes(1);
    });
    it('明确繁忙最多三次发送，按退避执行', async () => {
        await send(); api.sendTemplate.mockResolvedValue({ kind: 'retryable', code: -1 });
        await worker.run(); expect((await row()).oaSendStatus).toBe(OaSendStatus.PENDING);
        await worker.run(); expect(api.sendTemplate).toHaveBeenCalledTimes(1);
        for (let i = 0; i < 2; i++) {
            await ds.getRepository(Message).update((await row()).id, { oaNextAttemptAt: 0 });
            await worker.run();
        }
        expect((await row()).oaAttempts).toBe(3);
        expect((await row()).oaSendStatus).toBe(OaSendStatus.FAILED);
    });
    it('token 失效只刷新一次，每次发送均记次数', async () => {
        await send(); api.sendTemplate.mockResolvedValueOnce({ kind: 'token', code: 42001 });
        await worker.run();
        expect(api.invalidateToken).toHaveBeenCalledTimes(1);
        expect(api.sendTemplate).toHaveBeenCalledTimes(2);
        expect((await row()).oaAttempts).toBe(2);
        expect((await row()).oaSendStatus).toBe(OaSendStatus.SENT);
    });
    it('token 取得失败没有发送，保留待处理', async () => {
        await send(); api.getAccessToken.mockRejectedValue(new Error('token unavailable'));
        await worker.run();
        expect((await row()).oaAttempts).toBe(0);
        expect((await row()).oaSendStatus).toBe(OaSendStatus.PENDING);
        expect(api.sendTemplate).not.toHaveBeenCalled();
    });
    it('受理后本地写回失败只重试写库', async () => {
        await send();
        jest.spyOn(repo, 'settle').mockRejectedValueOnce(new Error('db busy'));
        await worker.run();
        expect(api.sendTemplate).toHaveBeenCalledTimes(1);
        expect((await row()).oaSendStatus).toBe(OaSendStatus.SENT);
    });
    it('领取后进程中断的旧 SENDING 恢复成 UNKNOWN', async () => {
        await send();
        await ds.getRepository(Message).update((await row()).id, { oaSendStatus: OaSendStatus.SENDING, oaClaimedAt: Date.now() - 180000 });
        await makeWorker().run();
        expect((await row()).oaSendStatus).toBe(OaSendStatus.UNKNOWN);
        expect(api.sendTemplate).not.toHaveBeenCalled();
    });
    it('一条领取失败时，另一条仍在处理期间不允许新一轮 worker 重入', async () => {
        await send(); await send('apply-2');
        let release: () => void, started: () => void;
        const paused = new Promise<void>(resolve => { release = resolve; });
        const active = new Promise<void>(resolve => { started = resolve; });
        jest.spyOn(repo, 'claim').mockRejectedValueOnce(new Error('db busy')).mockImplementation(async () => {
            started(); await paused; return false;
        });
        const recovery = jest.spyOn(repo, 'recoverInterrupted');
        const first = worker.run();
        await active;
        // 让首个领取失败沿 Promise 链传播，再模拟下一次调度；另一条仍暂停。
        await new Promise<void>(resolve => setImmediate(resolve));
        const second = worker.run();
        try { expect(recovery).toHaveBeenCalledTimes(1); }
        finally { release(); await Promise.all([first, second]); }
    });
    it('关闭通道/占位模板/字段超长仍保存站内信且不投递', async () => {
        (config as any).sendEnabled = false; await send('disabled');
        (config as any).sendEnabled = true;
        config.templates.REFUND_SUCCESS.templateId = 'REPLACE_TEMPLATE_ID'; await send('placeholder');
        config.templates.REFUND_SUCCESS.templateId = 'real-template-test';
        config.templates.REFUND_SUCCESS.fields.character_string2.maxLength = 1; await send('too-long');
        await worker.run();
        expect(await ds.getRepository(Message).countBy({ oaSendStatus: OaSendStatus.SKIPPED })).toBe(3);
        expect(api.sendTemplate).not.toHaveBeenCalled();
    });
    it('手动站内信永远不被后台 worker 误发', async () => {
        await service.sendAdminNotice({ openid: 'mini-a', title: '人工提醒', content: '正文', adminId: 1 });
        await worker.run();
        expect(await ds.getRepository(Message).countBy({ oaSendStatus: OaSendStatus.SKIPPED })).toBe(1);
        expect(api.sendTemplate).not.toHaveBeenCalled();
    });
});
