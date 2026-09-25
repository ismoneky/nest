import { Test } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { WechatOaController } from './wechat-oa.controller';
import { WechatOaConfig } from './wechat-oa.config';
import { WechatOaFanSyncService } from './wechat-oa-fan-sync.service';
import { WechatOaRepository } from '../../repositories/wechat-oa.repository';

describe('服务号运维接口鉴权', () => {
    let app: INestApplication, jwt: JwtService;
    const sync = jest.fn().mockResolvedValue({ status: 'COMPLETED', runId: 'run-1' });
    beforeAll(async () => {
        const mod = await Test.createTestingModule({
            imports: [JwtModule.register({ secret: process.env.JWT_SECRET || 'default_jwt_secret_change_in_production' })],
            controllers: [WechatOaController],
            providers: [{ provide: WechatOaConfig, useValue: Object.assign(new WechatOaConfig(), { secret: 'private-secret' }) },
                { provide: WechatOaFanSyncService, useValue: { sync } },
                { provide: WechatOaRepository, useValue: { status: async () => ({ lastCompletedAt: null, subscribed: 0, missingUnionId: 0, latest: null }) } }],
        }).compile();
        app = mod.createNestApplication(); await app.init(); jwt = mod.get(JwtService);
    });
    afterAll(async () => app?.close());
    it('匿名和普通小程序 token 不能触发同步', async () => {
        await request(app.getHttpServer()).post('/admin/wechat-oa/sync').expect(401);
        await request(app.getHttpServer()).post('/admin/wechat-oa/sync')
            .set('x-admin-token', jwt.sign({ openid: 'mini-a', userId: 'u-a' })).expect(401);
        expect(sync).not.toHaveBeenCalled();
    });
    it('管理员可以同步、查状态，状态响应不暴露凭据', async () => {
        const token = jwt.sign({ type: 'admin', adminId: 1, name: '测试管理员' });
        await request(app.getHttpServer()).post('/admin/wechat-oa/sync').set('x-admin-token', token).expect(200);
        const res = await request(app.getHttpServer()).get('/admin/wechat-oa/status').set('x-admin-token', token).expect(200);
        expect(res.text).not.toContain('private-secret');
        expect(res.body.data.syncStale).toBe(true);
        expect(res.body.data.templateReadiness.REFUND_SUCCESS).toBe(false);
        expect(Object.keys(res.body.data.templateReadiness)).toHaveLength(6);
    });
});
