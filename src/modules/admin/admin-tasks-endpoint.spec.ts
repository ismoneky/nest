import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { BookingService } from '../booking/booking.service';

/**
 * 手动触发定时任务的两个端点（`POST /admin/tasks/*`）
 *
 * ── 这个文件补的是什么 ────────────────────────────────────────────────────
 * 任务**逻辑**由 `booking-notify.spec.ts` 覆盖（22 个用例）——那两个端点调的就是
 * `runExpireScan` / `runDailyReminderScan`，与 `@Cron` 是同一个方法。
 *
 * 但「接口本身是通的」没有任何东西证明过：路由注册、守卫、DTO 校验、
 * 分钟→毫秒的转换、响应结构与错误路径——**这些出错时表现为 404 / 401 / 400 / 500，
 * 而任务逻辑的测试一个都拦不住**。本文件只测这一层。
 *
 * ── 为什么把 BookingService 换成替身 ──────────────────────────────────────
 * 这里要验的是"请求进来、参数出去"这条路，不是"扫到了几张单"。用替身可以断言
 * **service 实际收到了什么参数**（尤其是分钟→毫秒的换算），这比跑真库更能定位问题。
 * 真库那一侧已经由上面那个 spec 负责，两边不重复。
 *
 * 不依赖数据库、不启动调度器、不起 HTTP 端口：`createNestApplication` + supertest
 * 直接打内存里的 app，跑一次不到一秒。
 */
describe('POST /admin/tasks/*（手动触发端点）', () => {
    let app: INestApplication;
    let runExpireScan: jest.Mock;
    let runDailyReminderScan: jest.Mock;
    let adminToken: string;

    const JWT_SECRET = process.env.JWT_SECRET || 'default_jwt_secret_change_in_production';

    /** 一个"什么都没扫到"的成功结果，具体数值各用例按需覆盖 */
    const okExpire = (over: Record<string, unknown> = {}) => ({
        skipped: false,
        expiredCount: 0,
        notifiedCount: 0,
        quietWindowMinutes: 120,
        error: null,
        ...over,
    });

    const okDaily = (over: Record<string, unknown> = {}) => ({
        skipped: false,
        todayPendingCount: 0,
        remindedCount: 0,
        expiredPendingCount: 0,
        recalledCount: 0,
        quietWindowMinutes: 120,
        error: null,
        ...over,
    });

    beforeAll(async () => {
        runExpireScan = jest.fn().mockResolvedValue(okExpire());
        runDailyReminderScan = jest.fn().mockResolvedValue(okDaily());

        const moduleRef = await Test.createTestingModule({
            controllers: [AdminController],
            providers: [
                // AdminService 只在别的路由用到，本文件不碰它们，给个空壳即可
                { provide: AdminService, useValue: {} },
                { provide: BookingService, useValue: { runExpireScan, runDailyReminderScan } },
                JwtService,
            ],
        }).compile();

        app = moduleRef.createNestApplication();
        // 与 main.ts 的全局管道保持一致：DTO 校验必须在这条链路上真实生效，
        // 否则「越界值被拦下」这个断言测的是空气
        app.useGlobalPipes(
            new ValidationPipe({
                transform: true,
                whitelist: true,
                forbidNonWhitelisted: false,
                transformOptions: { enableImplicitConversion: true },
            }),
        );
        await app.init();

        adminToken = new JwtService().sign(
            { adminId: 1, username: 'tester', name: '测试管理员', type: 'admin' },
            { secret: JWT_SECRET, expiresIn: '1h' },
        );
    });

    afterAll(async () => {
        await app.close();
    });

    beforeEach(() => {
        runExpireScan.mockClear();
        runDailyReminderScan.mockClear();
    });

    describe('鉴权', () => {
        it('不带任何凭据 → 401，且不触达 service', async () => {
            await request(app.getHttpServer()).post('/admin/tasks/expire-scan').expect(401);
            expect(runExpireScan).not.toHaveBeenCalled();
        });

        it('admin token 无效 → 401（守卫是严格模式，不回退到 key）', async () => {
            await request(app.getHttpServer())
                .post('/admin/tasks/expire-scan')
                .set('x-admin-token', 'not-a-jwt')
                .expect(401);
            expect(runExpireScan).not.toHaveBeenCalled();
        });

        it('带合法 admin token → 通过', async () => {
            await request(app.getHttpServer())
                .post('/admin/tasks/expire-scan')
                .set('x-admin-token', adminToken)
                .expect(200);
            expect(runExpireScan).toHaveBeenCalledTimes(1);
        });
    });

    describe('静默期参数（分钟 → 毫秒）', () => {
        it('不传 → service 收到 undefined，由它落到 A 规则的默认 2 小时', async () => {
            await request(app.getHttpServer())
                .post('/admin/tasks/expire-scan')
                .set('x-admin-token', adminToken)
                .expect(200);

            expect(runExpireScan).toHaveBeenCalledWith({ quietWindowMs: undefined });
        });

        it('传 0 → 换算成 0 毫秒（不设静默期），不能变成 falsy 被丢掉', async () => {
            await request(app.getHttpServer())
                .post('/admin/tasks/expire-scan')
                .set('x-admin-token', adminToken)
                .send({ quietWindowMinutes: 0 })
                .expect(200);

            // 0 是合法值：写 `dto.x || undefined` 这类代码会把它吞掉，这条就是防那个
            expect(runExpireScan).toHaveBeenCalledWith({ quietWindowMs: 0 });
        });

        it('传 90 → 换算成 5400000 毫秒', async () => {
            await request(app.getHttpServer())
                .post('/admin/tasks/daily-reminder')
                .set('x-admin-token', adminToken)
                .send({ quietWindowMinutes: 90 })
                .expect(200);

            expect(runDailyReminderScan).toHaveBeenCalledWith({ quietWindowMs: 90 * 60 * 1000 });
        });

        it('越界值被 DTO 拦下 → 400，且不触达 service', async () => {
            for (const bad of [-1, 1441, 1.5]) {
                await request(app.getHttpServer())
                    .post('/admin/tasks/expire-scan')
                    .set('x-admin-token', adminToken)
                    .send({ quietWindowMinutes: bad })
                    .expect(400);
            }
            expect(runExpireScan).not.toHaveBeenCalled();
        });
    });

    describe('响应结构', () => {
        it('成功：message 里带上本次生效的静默期，data 原样透出统计', async () => {
            runExpireScan.mockResolvedValueOnce(okExpire({ expiredCount: 2, notifiedCount: 2, quietWindowMinutes: 0 }));

            const res = await request(app.getHttpServer())
                .post('/admin/tasks/expire-scan')
                .set('x-admin-token', adminToken)
                .send({ quietWindowMinutes: 0 })
                .expect(200);

            expect(res.body.success).toBe(true);
            // 手动触发最容易看错的就是"到底用了多少静默期"，所以它必须出现在人能直接读的 message 里
            expect(res.body.message).toContain('静默期 0 分钟');
            expect(res.body.data).toMatchObject({
                expiredCount: 2,
                notifiedCount: 2,
                quietWindowMinutes: 0,
                skipped: false,
                error: null,
            });
        });

        it('重入锁命中：skipped=true，message 说清"没执行"而不是报 0', async () => {
            runExpireScan.mockResolvedValueOnce(okExpire({ skipped: true }));

            const res = await request(app.getHttpServer())
                .post('/admin/tasks/expire-scan')
                .set('x-admin-token', adminToken)
                .expect(200);

            expect(res.body.message).toContain('上一轮尚未结束');
            expect(res.body.data.skipped).toBe(true);
        });

        it('任务内部抛错：转成 500，而不是把 error 藏在 200 里', async () => {
            runExpireScan.mockResolvedValueOnce(okExpire({ error: 'database is locked' }));

            const res = await request(app.getHttpServer())
                .post('/admin/tasks/expire-scan')
                .set('x-admin-token', adminToken)
                .expect(500);

            expect(JSON.stringify(res.body)).toContain('database is locked');
        });

        it('每日提醒端点同样可用（路由确实注册了，不是 404）', async () => {
            runDailyReminderScan.mockResolvedValueOnce(okDaily({ remindedCount: 3, recalledCount: 1 }));

            const res = await request(app.getHttpServer())
                .post('/admin/tasks/daily-reminder')
                .set('x-admin-token', adminToken)
                .expect(200);

            expect(res.body.message).toContain('核销提醒 3 条');
            expect(res.body.message).toContain('过期可退款提醒 1 条');
        });
    });
});
