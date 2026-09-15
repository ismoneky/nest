import { BadRequestException, INestApplication, NotFoundException, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { BookingController } from './booking.controller';
import { BookingService } from './booking.service';
import { RefundApplyService } from '../refund/refund-apply.service';

/**
 * `DELETE /bookings/:bookingId` 的**接口层**测试
 *
 * ── 这个文件补的是什么 ────────────────────────────────────────────────────
 * 删除的**业务语义**由 `booking-delete.spec.ts` 覆盖（17 个用例：可见性、幂等、
 * 归属、状态机不受影响）。但「这个接口本身是通的」没有任何东西证明过——
 * 路由注册、Guard、参数取用、响应结构、异常透传，**这些出错时表现为
 * 401 / 404 / 400 / 500，而服务层的测试一条都拦不住**。
 *
 * 顺带锁住一条安全性质：**管理员的 token 过不了这个接口**。管理员 token 的
 * payload 是 `{ adminId, username, name, type: 'admin' }`，**没有 openid**；
 * `JwtAuthGuard` 只验签名、不看 payload 形状，所以它会被放行进 controller，
 * 然后在归属校验处被 400 挡下。这正是「管理员不能删除订单」在代码上的落点——
 * 若哪天有人把它改成「管理员也能删」，这条用例会立刻变红。
 *
 * 不依赖数据库、不启动调度器、不起 HTTP 端口：`createNestApplication` + supertest
 * 直接打内存里的 app。用替身换掉 BookingService，可以断言 **service 实际收到了什么参数**
 * （尤其是 openid 是不是从 token 里取的），比跑真库更能定位问题。
 */
describe('DELETE /bookings/:bookingId（C 端删除订单端点）', () => {
    let app: INestApplication;
    let deleteBooking: jest.Mock;
    let userToken: string;
    let adminToken: string;

    const JWT_SECRET = process.env.JWT_SECRET || 'default_jwt_secret_change_in_production';
    const OPENID = 'openid-del-endpoint';
    const BOOKING_ID = 'TL-DEL-EP-1';

    beforeAll(async () => {
        deleteBooking = jest.fn().mockResolvedValue({ bookingId: BOOKING_ID, alreadyDeleted: false });

        const moduleRef = await Test.createTestingModule({
            controllers: [BookingController],
            providers: [
                { provide: BookingService, useValue: { deleteBooking } },
                // 本文件只碰删除路由；其它路由的协作者给空壳即可
                { provide: RefundApplyService, useValue: {} },
                JwtService,
            ],
        }).compile();

        app = moduleRef.createNestApplication();
        // 与 main.ts 的全局管道保持一致：这条链路上真实生效的校验必须一致，
        // 否则「参数被正确处理」这个断言测的是空气
        app.useGlobalPipes(
            new ValidationPipe({
                transform: true,
                whitelist: true,
                forbidNonWhitelisted: false,
                transformOptions: { enableImplicitConversion: true },
            }),
        );
        await app.init();

        const jwt = new JwtService();
        userToken = jwt.sign({ openid: OPENID, userId: 'u-1' }, { secret: JWT_SECRET, expiresIn: '1h' });
        adminToken = jwt.sign(
            { adminId: 1, username: 'tester', name: '测试管理员', type: 'admin' },
            { secret: JWT_SECRET, expiresIn: '1h' },
        );
    });

    afterAll(async () => {
        await app.close();
    });

    beforeEach(() => {
        deleteBooking.mockClear();
        deleteBooking.mockResolvedValue({ bookingId: BOOKING_ID, alreadyDeleted: false });
    });

    it('不带 token → 401，且不触达 service', async () => {
        await request(app.getHttpServer()).delete(`/bookings/${BOOKING_ID}`).expect(401);
        expect(deleteBooking).not.toHaveBeenCalled();
    });

    it('token 无效 → 401', async () => {
        await request(app.getHttpServer())
            .delete(`/bookings/${BOOKING_ID}`)
            .set('Authorization', 'Bearer not-a-jwt')
            .expect(401);
        expect(deleteBooking).not.toHaveBeenCalled();
    });

    it('**管理员 token 被拒**（payload 无 openid，过不了归属校验）', async () => {
        // 守卫只验签名，所以这个请求会进到 controller 再被服务层挡下。
        // 这里让替身如实模拟那一幕：openid 为空时必须抛错
        deleteBooking.mockImplementationOnce((_id: string, openid: string) => {
            if (!openid) throw new BadRequestException('无权操作该订单');
            return Promise.resolve({ bookingId: BOOKING_ID, alreadyDeleted: false });
        });

        await request(app.getHttpServer())
            .delete(`/bookings/${BOOKING_ID}`)
            .set('Authorization', `Bearer ${adminToken}`)
            .expect(400);

        // 管理员 token 里没有 openid → 服务层拿到的是 undefined，因此**必然**被拒。
        // 这就是「管理员不能删除订单」在代码上的落点
        expect(deleteBooking).toHaveBeenCalledWith(BOOKING_ID, undefined);
    });

    it('本人 token → 200，service 收到「路径上的订单号 + token 里的 openid」', async () => {
        const res = await request(app.getHttpServer())
            .delete(`/bookings/${BOOKING_ID}`)
            .set('Authorization', `Bearer ${userToken}`)
            .expect(200);

        expect(deleteBooking).toHaveBeenCalledWith(BOOKING_ID, OPENID);
        expect(res.body.success).toBe(true);
        expect(res.body.message).toBe('订单已删除');
        expect(res.body.data).toEqual({ bookingId: BOOKING_ID, alreadyDeleted: false });
    });

    it('重复删除同样是 200（幂等由 service 表达，接口不报错）', async () => {
        deleteBooking.mockResolvedValueOnce({ bookingId: BOOKING_ID, alreadyDeleted: true });

        const res = await request(app.getHttpServer())
            .delete(`/bookings/${BOOKING_ID}`)
            .set('Authorization', `Bearer ${userToken}`)
            .expect(200);

        expect(res.body.data.alreadyDeleted).toBe(true);
    });

    it('service 抛 NotFoundException → 404 原样透传（不 catch、不压成 400）', async () => {
        deleteBooking.mockRejectedValueOnce(new NotFoundException('Booking with ID X not found'));

        await request(app.getHttpServer())
            .delete(`/bookings/${BOOKING_ID}`)
            .set('Authorization', `Bearer ${userToken}`)
            .expect(404);
    });
});
