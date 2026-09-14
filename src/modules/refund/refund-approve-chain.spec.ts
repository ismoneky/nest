import { Test } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Booking, BookingStatus, PaymentStatus, RefundStatus, TravelMode, TimeSlot } from '../../entities/booking.entity';
import { BookingAnomaly } from '../../entities/booking-anomaly.entity';
import { RefundApply, RefundApplyStatus } from '../../entities/refund-apply.entity';
import { Message } from '../../entities/message.entity';
import { BookingRepository } from '../../repositories/booking.repository';
import { RefundApplyRepository } from '../../repositories/refund-apply.repository';
import { MessageRepository } from '../../repositories/message.repository';
import { MessageService } from '../message/message.service';
import { SystemConfigService } from '../system-config/system-config.service';
import { RefundApplyService, buildOutRefundNo } from '../refund/refund-apply.service';
import { BookingService } from '../booking/booking.service';
import { AdminService } from '../admin/admin.service';

/**
 * 「审核通过 → 退款真的发起」的**链路级**回归测试
 *
 * ── 这个文件为什么必须存在 ────────────────────────────────────────────────
 * 这是全系统唯一「点一下就把钱退出去」的路径，而它横跨三个类：
 *   `AdminService.approveRefundApply` → `RefundApplyService.prepareApproval`
 *   → `BookingService.initiateRefund` → `markRefundStarting`（条件更新）。
 *
 * 而 `refund-apply.spec.ts` 只搭了 `RefundApplyService`、`booking-expire.spec.ts`
 * 只搭了 `BookingRepository`——**没有任何一个测试把这条链接起来**。
 * 后果是真实存在过的：`initiateRefund` 的归属校验不认 `options.asAdmin`，
 * 而审核路径按设计传 `openid = ''`，于是「审核通过」100% 抛「无权操作该订单」：
 * 单据已落 `approved`、退款一分没发起、且因状态不再是 pending 而**无法重试**。
 * 三个类的单元测试全绿，钱退不出去。
 *
 * ── 这个文件测的是「接线」，不是任何一个类内部的行为 ──────────────────────
 * 断言落在**数据库状态**上（`bookings.refundStatus` 有没有真的走到 `refunding`），
 * 而不是「调用过某个方法」——后者在接线断掉时同样会通过。
 *
 * 夹具均为虚构数据，不含真实用户信息。
 */
describe('审核通过 → 退款发起（链路级）', () => {
    let adminService: AdminService;
    let bookingService: BookingService;
    let refundApplyService: RefundApplyService;
    let bookingRawRepo: Repository<Booking>;
    let applyRawRepo: Repository<RefundApply>;

    const OPENID = 'openid-chain-test';
    const DAY_MS = 24 * 60 * 60 * 1000;

    const systemConfigStub = {
        getRefundApplyDeadlineDays: () => 7,
        getRefundMaxApplyCount: () => 3,
        getRefundContactPhone: () => '13800000000',
    };

    /** 日志桩：审核链路会写审计日志，失败会盖住真正的错误，这里必须给可用的壳 */
    const loggingStub = { write: () => Promise.resolve() };

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({
            imports: [
                TypeOrmModule.forRoot({
                    type: 'sqlite',
                    database: ':memory:',
                    synchronize: true,
                    dropSchema: true,
                    entities: [Booking, BookingAnomaly, RefundApply, Message],
                }),
                TypeOrmModule.forFeature([Booking, BookingAnomaly, RefundApply, Message]),
            ],
            providers: [
                BookingRepository,
                RefundApplyRepository,
                MessageRepository,
                MessageService,
                { provide: SystemConfigService, useValue: systemConfigStub },
            ],
        }).compile();

        const bookingRepository = moduleRef.get(BookingRepository);
        const refundApplyRepository = moduleRef.get(RefundApplyRepository);
        const messageService = moduleRef.get(MessageService);
        const systemConfigService = moduleRef.get(SystemConfigService);

        bookingRawRepo = moduleRef.get(getRepositoryToken(Booking));
        applyRawRepo = moduleRef.get(getRepositoryToken(RefundApply));

        refundApplyService = new RefundApplyService(refundApplyRepository, systemConfigService, messageService);

        // BookingService 的其余协作者（微信、会员、资料、数据源）在被测路径上不会被触达：
        // 链路在 `markRefundStarting` 之后才会调微信，而那一步之前的所有写入都已完成。
        bookingService = new BookingService(
            bookingRepository,
            null as any, // wechatPayService：真实调用会抛错，正好用来验「不回滚 approved」
            systemConfigService,
            null as any, // adminApplicationRepository
            null as any, // dataSource
            null as any, // memberService
            null as any, // userProfileRepository
            loggingStub as any,
            refundApplyRepository,
            messageService,
        );

        // AdminService 只用到 bookingService / refundApplyService / loggingService 三个
        adminService = new AdminService(
            null as any, // adminRepository
            bookingService,
            null as any, // jwtService
            refundApplyService,
            loggingStub as any,
            messageService,
        );
    });

    let seq = 0;
    async function seedExpiredBookingWithApply(): Promise<{ bookingId: string; applyNo: string }> {
        seq += 1;
        const bookingId = `TL-CHAIN-${seq}`;
        await bookingRawRepo.save(
            bookingRawRepo.create({
                bookingId,
                wechatOpenId: OPENID,
                name: '测试',
                phone: '13800000000',
                bookingDate: new Date(Date.now() - DAY_MS) as any,
                timeSlot: TimeSlot.MORNING,
                travelMode: TravelMode.SELF_DRIVING,
                personCount: 1,
                remarks: '',
                isFree: false,
                status: BookingStatus.EXPIRED,
                paymentStatus: PaymentStatus.PAID,
                refundStatus: RefundStatus.NONE,
                amount: 6600,
                expiredAt: new Date(Date.now() - DAY_MS),
            }),
        );

        const booking = await bookingService.getBookingById(bookingId, OPENID);
        const apply = await refundApplyService.submitApply(booking, OPENID, '当天没扫上码');
        return { bookingId, applyNo: apply.applyNo };
    }

    it('【关键】管理员点通过后，订单真的进入 refunding（退款被发起，而不是只改了单据）', async () => {
        const { bookingId, applyNo } = await seedExpiredBookingWithApply();

        // 审核通过。微信协作者是 null，所以本次调用最终会抛错——这**正是设计要的行为**：
        // 微信失败不回滚 approved，订单停在 refunding，交给 15 分钟对账收敛。
        await adminService
            .approveRefundApply(applyNo, { adminId: 1, adminName: '审核员' })
            .catch(() => undefined);

        const booking = await bookingRawRepo.findOneOrFail({ where: { bookingId } });
        // 这两条断言是整个文件的重点：接线断掉时它们会是 none / null
        expect(booking.refundStatus).toBe(RefundStatus.REFUNDING);
        expect(booking.reconcileKind).toBe('refund');
        expect(booking.outRefundNo).toBe(buildOutRefundNo(bookingId, 1));

        const apply = await applyRawRepo.findOneOrFail({ where: { applyNo } });
        expect(apply.status).toBe(RefundApplyStatus.APPROVED);
        expect(apply.outRefundNo).toBe(buildOutRefundNo(bookingId, 1));
        expect(apply.auditAdminName).toBe('审核员');
    });

    it('审核路径不受归属校验影响（它本来就不该有下单人的 openid）', async () => {
        const { bookingId } = await seedExpiredBookingWithApply();

        // 直接按 approveRefundApply 的方式调用：openid 传空串
        const message = await bookingService
            .initiateRefund(bookingId, '', { asAdmin: true, outRefundNo: buildOutRefundNo(bookingId, 1) })
            .then(() => null, (e: Error) => e.message);

        // 允许失败（微信协作者是 null），但**不允许**失败在归属校验上
        expect(message).not.toContain('无权操作该订单');

        const booking = await bookingRawRepo.findOneOrFail({ where: { bookingId } });
        expect(booking.refundStatus).toBe(RefundStatus.REFUNDING);
    });

    it('用户自助路径的归属校验没有被放宽（他人 openid 与空 openid 都必须被拒）', async () => {
        const { bookingId } = await seedExpiredBookingWithApply();

        for (const openid of ['openid-别人', '']) {
            const message = await bookingService
                .initiateRefund(bookingId, openid)
                .then(() => null, (e: Error) => e.message);
            expect(message).toBe('无权操作该订单');
        }

        const booking = await bookingRawRepo.findOneOrFail({ where: { bookingId } });
        expect(booking.refundStatus).toBe(RefundStatus.NONE);
    });

    it('并发审核互斥：第二个管理员拿到 APPLY_ALREADY_HANDLED，且不产生第二次退款', async () => {
        const { bookingId, applyNo } = await seedExpiredBookingWithApply();

        await adminService
            .approveRefundApply(applyNo, { adminId: 1, adminName: '审核员A' })
            .catch(() => undefined);

        const second = await adminService
            .approveRefundApply(applyNo, { adminId: 2, adminName: '审核员B' })
            .then(() => null, (e: { code?: string }) => e.code);

        expect(second).toBe('APPLY_ALREADY_HANDLED');

        // 订单上的退款单号仍是第一次那一个：第二次没有改写任何东西
        const booking = await bookingRawRepo.findOneOrFail({ where: { bookingId } });
        expect(booking.outRefundNo).toBe(buildOutRefundNo(bookingId, 1));
    });
});
