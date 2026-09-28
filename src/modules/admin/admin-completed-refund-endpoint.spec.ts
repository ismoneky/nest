import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { BookingService } from '../booking/booking.service';

describe('POST /admin/bookings/:bookingId/refund', () => {
    let app: INestApplication;
    let refundBookingAsAdmin: jest.Mock;
    let adminToken: string;

    const JWT_SECRET = process.env.JWT_SECRET || 'default_jwt_secret_change_in_production';

    beforeAll(async () => {
        refundBookingAsAdmin = jest.fn().mockResolvedValue({ state: 'accepted' });
        const moduleRef = await Test.createTestingModule({
            controllers: [AdminController],
            providers: [
                { provide: AdminService, useValue: { refundBookingAsAdmin } },
                { provide: BookingService, useValue: {} },
                JwtService,
            ],
        }).compile();

        app = moduleRef.createNestApplication();
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
            { adminId: 7, username: 'refund-admin', name: '退款管理员', type: 'admin' },
            { secret: JWT_SECRET, expiresIn: '1h' },
        );
    });

    afterAll(async () => {
        await app.close();
    });

    beforeEach(() => {
        refundBookingAsAdmin.mockClear();
    });

    it('合法管理员提交二级密码后收到退款已受理响应', async () => {
        const response = await request(app.getHttpServer())
            .post('/admin/bookings/TL-COMPLETED-1/refund')
            .set('x-admin-token', adminToken)
            .send({ secondaryPassword: 'refund-only-2026' })
            .expect(200);

        expect(response.body).toEqual({
            success: true,
            message: '退款申请已提交',
            data: { state: 'accepted' },
        });
        expect(refundBookingAsAdmin).toHaveBeenCalledWith(
            'TL-COMPLETED-1',
            'refund-only-2026',
            { adminId: 7, adminName: '退款管理员' },
        );
    });

    it('未登录请求被拒绝且不触达退款服务', async () => {
        await request(app.getHttpServer())
            .post('/admin/bookings/TL-COMPLETED-1/refund')
            .send({ secondaryPassword: 'refund-only-2026' })
            .expect(401);

        expect(refundBookingAsAdmin).not.toHaveBeenCalled();
    });

    it('缺少二级密码时由 DTO 拒绝请求', async () => {
        await request(app.getHttpServer())
            .post('/admin/bookings/TL-COMPLETED-1/refund')
            .set('x-admin-token', adminToken)
            .send({})
            .expect(400);

        expect(refundBookingAsAdmin).not.toHaveBeenCalled();
    });
});
