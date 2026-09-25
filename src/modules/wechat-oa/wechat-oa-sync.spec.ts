import { DataSource } from 'typeorm';
import { WechatOaFan } from '../../entities/wechat-oa-fan.entity';
import { WechatOaSyncRun } from '../../entities/wechat-oa-sync-run.entity';
import { User } from '../../entities/user.entity';
import { WechatOaRepository } from '../../repositories/wechat-oa.repository';
import { WechatOaFanSyncService } from './wechat-oa-fan-sync.service';
import { OA_FAN_SYNC_CRON, WechatOaConfig } from './wechat-oa.config';
import { UserRepository } from '../../repositories/user.repository';

describe('服务号粉丝同步与关联', () => {
    let ds: DataSource, repo: WechatOaRepository, sync: WechatOaFanSyncService;
    let api: { listFans: jest.Mock; getFanInfo: jest.Mock };
    const appId = 'wx0123456789abcdef';
    const config = { syncEnabled: true, workerEnabled: true, appId, credentialsReady: () => true } as WechatOaConfig;
    beforeEach(async () => {
        ds = await new DataSource({ type: 'sqlite', database: ':memory:', synchronize: true,
            entities: [WechatOaFan, WechatOaSyncRun, User] }).initialize();
        repo = new WechatOaRepository(ds.getRepository(WechatOaFan), ds.getRepository(WechatOaSyncRun), ds.getRepository(User));
        api = { listFans: jest.fn(), getFanInfo: jest.fn() };
        sync = new WechatOaFanSyncService(config, api as any, repo);
    });
    afterEach(async () => ds.destroy());
    async function seed(ids: string[]) {
        const run = await repo.startRun(appId, Date.now() - 10000);
        await repo.markSeen(appId, ids, run.runId, run.startedAt);
        await repo.finishRun(run, ids.length, 0, 0);
    }

    it('调度固定为偶数小时 43 分', () => expect(OA_FAN_SYNC_CRON).toBe('0 43 */2 * * *'));
    it('完整扫描后标记缺席粉丝退订，按小程序 OpenID/UnionID 关联', async () => {
        await seed(['oa-old']);
        await new UserRepository(ds.getRepository(User)).findOrCreateUser({ wechatOpenId: 'mini-a', wechatUnionId: 'union-a' });
        api.listFans.mockResolvedValue({ total: 1, openids: ['oa-a'], next: 'oa-a' });
        api.getFanInfo.mockResolvedValue([{ openid: 'oa-a', subscribe: 1, unionid: 'union-a' }]);
        expect((await sync.sync()).status).toBe('COMPLETED');
        expect((await ds.getRepository(WechatOaFan).findOneBy({ oaOpenId: 'oa-old' })).subscribed).toBe(0);
        expect(await repo.resolveRecipient('mini-a', appId)).toEqual({ kind: 'ready', openid: 'oa-a' });
        expect((await repo.resolveRecipient('mini-a', 'another-app')).kind).toBe('waiting');
    });
    it('第二页失败不能把未扫描到的粉丝全部退订', async () => {
        await seed(['oa-old']);
        api.listFans.mockResolvedValueOnce({ total: 2, openids: ['oa-a'], next: 'oa-a' }).mockRejectedValueOnce(new Error('bad page'));
        api.getFanInfo.mockResolvedValue([{ openid: 'oa-a', subscribe: 1 }]);
        expect((await sync.sync()).status).toBe('FAILED');
        expect((await ds.getRepository(WechatOaFan).findOneBy({ oaOpenId: 'oa-old' })).subscribed).toBe(1);
    });
    it('真正的零粉丝完整列表可清除关注状态', async () => {
        await seed(['oa-old']); api.listFans.mockResolvedValue({ total: 0, openids: [], next: '' });
        expect((await sync.sync()).status).toBe('COMPLETED');
        expect(await ds.getRepository(WechatOaFan).countBy({ subscribed: 1 })).toBe(0);
    });
    it('重复游标失败，用户信息批次失败不阻塞完整列表对账', async () => {
        await seed(['oa-old']);
        api.listFans.mockResolvedValue({ total: 3, openids: ['oa-a'], next: 'oa-a' });
        api.getFanInfo.mockRejectedValue(new Error('info failed'));
        expect((await sync.sync()).status).toBe('FAILED');
        expect((await ds.getRepository(WechatOaFan).findOneBy({ oaOpenId: 'oa-old' })).subscribed).toBe(1);
        api.listFans.mockResolvedValue({ total: 1, openids: ['oa-a'], next: '' });
        expect((await sync.sync()).status).toBe('COMPLETED');
        expect((await ds.getRepository(WechatOaFan).findOneBy({ oaOpenId: 'oa-old' })).subscribed).toBe(0);
    });
    it('旧扫描不能把发送接口刚确认退订的人恢复关注', async () => {
        await seed(['oa-a']);
        const startedAt = Date.now() - 1000;
        const run = await repo.startRun(appId, startedAt);
        await repo.markUnsubscribed(appId, 'oa-a', Date.now());
        await repo.markSeen(appId, ['oa-a'], run.runId, startedAt);
        await repo.applyInfo(appId, [{ openid: 'oa-a', subscribe: 1, unionid: 'union-a' }], startedAt);
        await repo.finishRun(run, 1, 1, 0);
        expect((await ds.getRepository(WechatOaFan).findOneBy({ oaOpenId: 'oa-a' })).subscribed).toBe(0);
    });
    it('UnionID 冲突冻结双方，后续缺字段不能清空已有 UnionID', async () => {
        await seed(['oa-a', 'oa-b']);
        await repo.applyInfo(appId, [{ openid: 'oa-a', subscribe: 1, unionid: 'union-a' }], Date.now());
        await repo.applyInfo(appId, [{ openid: 'oa-a', subscribe: 1 }, { openid: 'oa-b', subscribe: 1, unionid: 'union-a' }], Date.now());
        expect((await ds.getRepository(WechatOaFan).findOneBy({ oaOpenId: 'oa-a' })).unionId).toBe('union-a');
        expect(await ds.getRepository(WechatOaFan).countBy({ identityConflict: 1 })).toBe(2);
    });
});
