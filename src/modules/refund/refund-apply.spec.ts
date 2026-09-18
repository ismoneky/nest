import { Test } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Booking, BookingStatus, PaymentStatus, RefundStatus, TravelMode, TimeSlot } from '../../entities/booking.entity';
import { BookingAnomaly } from '../../entities/booking-anomaly.entity';
import { RefundApply, RefundApplyStatus } from '../../entities/refund-apply.entity';
import { RefundApplyRepository } from '../../repositories/refund-apply.repository';
import { MessageRepository } from '../../repositories/message.repository';
import { Message, MessageType } from '../../entities/message.entity';
import { MessageService } from '../message/message.service';
import { SystemConfigService } from '../system-config/system-config.service';
import { RefundApplyService, buildOutRefundNo } from './refund-apply.service';
import { RefundErrorCode } from '../../common/refund-errors';

/**
 * 阶段 3「退款申请与审核」的核心不变式测试。
 *
 * 锁定六件事：
 *   1. **入口显隐**：`refundEntry` 的五个判定条件与优先级（前端只读 `visible`，
 *      所以这里的任何一处放宽都等于线上放开了退款入口）；
 *   2. **服务端拦截独立于显隐**：`submitApply` 自己重跑同一套校验，
 *      不依赖前端、也不依赖调用方是否读过 `refundEntry`；
 *   3. **次数语义**：被驳回不消耗申请次数，但**消耗序号**——
 *      序号单调递增是与唯一索引 `(bookingId, applyCount)` 的契约，
 *      额度与序号用两个口径是刻意的（用同一个口径必然撞唯一索引）；
 *   4. **审核互斥**：`pending` 条件下两个管理员同时点「通过」只有一个生效，
 *      另一个拿到 `APPLY_ALREADY_HANDLED`。互斥来自条件 UPDATE，不是读-判-写；
 *   5. **资金结果镜像幂等**：回调 / 15 分钟对账 / 异常通道三条路径都会收敛同一笔退款，
 *      重复调用必须是 no-op，且**只对 approved 生效**；
 *   6. **退款单号换号**：第 2 次申请必须拿到与第 1 次不同的 `outRefundNo`，
 *      否则微信会因幂等返回那张已关闭的退款单，钱永远退不出去。
 *
 * 夹具均为虚构数据，不含真实用户信息。
 */
describe('阶段 3 退款申请与审核', () => {
    let service: RefundApplyService;
    let applyRepo: RefundApplyRepository;
    let bookingRepo: Repository<Booking>;
    let applyRawRepo: Repository<RefundApply>;
    let messageRepo: Repository<Message>;
    let messageService: MessageService;

    const OPENID = 'openid-refund-test';
    const DEADLINE_DAYS = 7;
    const MAX_APPLY = 3;
    const DAY_MS = 24 * 60 * 60 * 1000;

    /** 系统配置用桩：只提供退款相关的三个读取口，其余方法在被测路径上不会触达 */
    const systemConfigStub = {
        getRefundApplyDeadlineDays: () => DEADLINE_DAYS,
        getRefundMaxApplyCount: () => MAX_APPLY,
        getRefundContactPhone: () => '',
    };

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
                RefundApplyRepository,
                RefundApplyService,
                // 站内信：阶段 4 给 RefundApplyService 加了四个发送点，
                // 这里用**真实**的 MessageService 而不是桩——「真的落了一条消息」
                // 正是要测的东西（见文件末尾的「退款流程的站内信」）。
                MessageRepository,
                MessageService,
                { provide: SystemConfigService, useValue: systemConfigStub },
            ],
        }).compile();

        service = moduleRef.get(RefundApplyService);
        applyRepo = moduleRef.get(RefundApplyRepository);
        bookingRepo = moduleRef.get(getRepositoryToken(Booking));
        applyRawRepo = moduleRef.get(getRepositoryToken(RefundApply));
        messageRepo = moduleRef.get(getRepositoryToken(Message));
        messageService = moduleRef.get(MessageService);
    });

    let seq = 0;

    /**
     * 造一张订单。默认「已过期 + 已支付 + 非免费 + 刚过期」——即退款入口的全部前置条件。
     *
     * @param over 覆盖字段（改 status/paymentStatus/expiredAt 等来构造反例）
     */
    async function seedBooking(over: Partial<Booking> = {}): Promise<Booking> {
        seq += 1;
        return await bookingRepo.save(
            bookingRepo.create({
                bookingId: `TL-REFUND-${seq}`,
                wechatOpenId: OPENID,
                name: '测试',
                phone: '13800000000',
                bookingDate: new Date('2026-09-01T00:00:00') as any,
                timeSlot: TimeSlot.MORNING,
                travelMode: TravelMode.SELF_DRIVING,
                personCount: 1,
                remarks: '',
                isFree: false,
                status: BookingStatus.EXPIRED,
                paymentStatus: PaymentStatus.PAID,
                refundStatus: RefundStatus.NONE,
                amount: 5000,
                expiredAt: new Date(Date.now() - DAY_MS),
                ...over,
            }),
        );
    }

    /** 造一条申请单（直接落库，绕过 applyCount 分配逻辑，用于构造状态组合） */
    async function seedApply(
        booking: Booking,
        status: RefundApplyStatus,
        applyCount = 1,
    ): Promise<RefundApply> {
        return await applyRawRepo.save(
            applyRawRepo.create({
                applyNo: `RA-TEST-${booking.bookingId}-${applyCount}`,
                bookingId: booking.bookingId,
                wechatOpenId: booking.wechatOpenId,
                applyCount,
                reason: '临时有事无法前往',
                status,
                refundAmount: booking.amount ?? 0,
                outRefundNo: buildOutRefundNo(booking.bookingId, applyCount),
            }),
        );
    }

    /** 期待 submitApply 抛出指定错误码 */
    async function expectRefundError(fn: () => Promise<unknown>, code: string): Promise<void> {
        await expect(fn()).rejects.toMatchObject({ code });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 一、入口显隐（refundEntry）
    // ─────────────────────────────────────────────────────────────────────────

    describe('refundEntry 显隐', () => {
        it('已过期 + 已支付 + 非免费 + 未超期 → visible=true，且下发截止时刻与次数上限', async () => {
            const booking = await seedBooking();
            const entry = await service.buildRefundEntry(booking);

            expect(entry.visible).toBe(true);
            expect(entry.reason).toBeNull();
            expect(entry.appliedCount).toBe(0);
            expect(entry.maxApplyCount).toBe(MAX_APPLY);
            expect(entry.latestApply).toBeNull();
            // 截止时刻 = expiredAt + 7 天（基准是 expiredAt 而不是 bookingDate）
            expect(entry.applyDeadline).toBe(new Date(booking.expiredAt).getTime() + DEADLINE_DAYS * DAY_MS);
        });

        it('客服电话随入口一起下发：驳回/失败/超期三处文案都靠它，不能让前端另调接口', async () => {
            const booking = await seedBooking();
            const entry = await service.buildRefundEntry(booking);

            // 桩返回空串 → 原样下发，前端整行隐藏（不是 undefined，避免前端各写一套兜底）
            expect(entry.contactPhone).toBe('');
        });

        it('confirmed 订单 → NOT_EXPIRED（未过期走既有自助退款入口，不该看到申请按钮）', async () => {
            const booking = await seedBooking({ status: BookingStatus.CONFIRMED, expiredAt: null as any });
            const entry = await service.buildRefundEntry(booking);

            expect(entry.visible).toBe(false);
            expect(entry.reason).toBe('NOT_EXPIRED');
        });

        it('免费预约 → FREE_ORDER', async () => {
            const booking = await seedBooking({ isFree: true, amount: 0 });
            const entry = await service.buildRefundEntry(booking);

            expect(entry.reason).toBe('FREE_ORDER');
        });

        it('未支付 → NOT_PAID', async () => {
            const booking = await seedBooking({ paymentStatus: PaymentStatus.UNPAID });
            const entry = await service.buildRefundEntry(booking);

            expect(entry.reason).toBe('NOT_PAID');
        });

        it('已退款（paymentStatus=refunded）→ NOT_PAID，不再给入口', async () => {
            const booking = await seedBooking({
                paymentStatus: PaymentStatus.REFUNDED,
                refundStatus: RefundStatus.REFUNDED,
            });
            const entry = await service.buildRefundEntry(booking);

            expect(entry.reason).toBe('NOT_PAID');
        });

        it('超过申请时限 → DEADLINE_EXCEEDED（硬性上限，入口永久关闭）', async () => {            const booking = await seedBooking({
                expiredAt: new Date(Date.now() - (DEADLINE_DAYS + 1) * DAY_MS),
            });
            const entry = await service.buildRefundEntry(booking);

            expect(entry.visible).toBe(false);
            expect(entry.reason).toBe('DEADLINE_EXCEEDED');
        });

        it('超期判定优先于「审核中」：超期且审核中的单，用户该看到的是超期而不是进度', async () => {
            const booking = await seedBooking({
                expiredAt: new Date(Date.now() - (DEADLINE_DAYS + 1) * DAY_MS),
            });
            await seedApply(booking, RefundApplyStatus.PENDING);

            const entry = await service.buildRefundEntry(booking);
            expect(entry.reason).toBe('DEADLINE_EXCEEDED');
        });

        it('存在 pending 申请 → APPLY_IN_PROGRESS', async () => {
            const booking = await seedBooking();
            await seedApply(booking, RefundApplyStatus.PENDING);

            const entry = await service.buildRefundEntry(booking);
            expect(entry.visible).toBe(false);
            expect(entry.reason).toBe('APPLY_IN_PROGRESS');
            expect(entry.latestApply?.status).toBe(RefundApplyStatus.PENDING);
        });

        it('latestApply 取序号最大的一条（驳回理由随之下发）；有驳回记录即终态，不再给入口', async () => {
            const booking = await seedBooking();
            await seedApply(booking, RefundApplyStatus.SUCCESS, 1);
            await seedApply(booking, RefundApplyStatus.FAILED, 2);
            await applyRawRepo.save(
                applyRawRepo.create({
                    applyNo: `RA-LIMIT-C-${booking.bookingId}`,
                    bookingId: booking.bookingId,
                    wechatOpenId: booking.wechatOpenId,
                    applyCount: 3,
                    reason: '第三次',
                    status: RefundApplyStatus.REJECTED,
                    refundAmount: 5000,
                    rejectReason: '已核销无法退款',
                }),
            );

            const entry = await service.buildRefundEntry(booking);

            // 最新一条（applyCount 最大的）是第 3 次，驳回理由随之下发
            expect(entry.latestApply?.applyCount).toBe(3);
            expect(entry.latestApply?.rejectReason).toBe('已核销无法退款');
            // 被驳回的不计入「已消耗次数」这个计数口径（success + failed = 2）
            expect(entry.appliedCount).toBe(2);
            // 但**驳回是终态**（2026-09-13 决策）：有驳回记录就不再开放入口，
            // 用户该联系管理员，而不是反复提交
            expect(entry.visible).toBe(false);
            expect(entry.reason).toBe('APPLY_REJECTED');
        });

        it('过期但缺 expiredAt → DEADLINE_UNAVAILABLE（fail-closed，不把数据缺失当成"永久可退"）', async () => {
            // 触发条件只有手工 SQL（markExpired 必写 expiredAt），属防御性分支；
            // 但它是「7 天是硬性上限」的兜底：判不出时限就不能放行
            const booking = await seedBooking({ expiredAt: null as any });

            const entry = await service.buildRefundEntry(booking);

            expect(entry.visible).toBe(false);
            expect(entry.reason).toBe('DEADLINE_UNAVAILABLE');
            expect(entry.applyDeadline).toBeNull();
        });

        it('非 expired 订单**不查申请单表**（详情接口是热点：5 秒轮询）', async () => {
            const booking = await seedBooking({ status: BookingStatus.CONFIRMED });
            const spies = [
                jest.spyOn(applyRepo, 'countConsumedApplies'),
                jest.spyOn(applyRepo, 'hasOpenApply'),
                jest.spyOn(applyRepo, 'hasRejectedApply'),
                jest.spyOn(applyRepo, 'findLatestByBookingId'),
            ];

            const entry = await service.buildRefundEntry(booking);

            expect(entry.reason).toBe('NOT_EXPIRED');
            // 这三个查询的结果在非 expired 时必然用不到，白付的读放大在单连接 SQLite 上是纯损耗
            for (const spy of spies) expect(spy).not.toHaveBeenCalled();
            for (const spy of spies) spy.mockRestore();
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 二、提交申请（服务端拦截）
    // ─────────────────────────────────────────────────────────────────────────

    describe('submitApply 服务端拦截', () => {
        it('正常提交：落 pending、带序号 1、金额取订单金额，且**不动订单任何状态字段**', async () => {
            const booking = await seedBooking();
            const before = await bookingRepo.findOne({ where: { bookingId: booking.bookingId } });

            const apply = await service.submitApply(booking, OPENID, '  临时有事无法前往  ');

            expect(apply.status).toBe(RefundApplyStatus.PENDING);
            expect(apply.applyCount).toBe(1);
            expect(apply.refundAmount).toBe(5000);
            expect(apply.reason).toBe('临时有事无法前往'); // 已 trim
            expect(apply.applyNo).toMatch(/^RA/);

            const after = await bookingRepo.findOne({ where: { bookingId: booking.bookingId } });
            expect(after!.status).toBe(before!.status);
            expect(after!.paymentStatus).toBe(before!.paymentStatus);
            expect(after!.refundStatus).toBe(before!.refundStatus);
        });

        it('归属校验：非本人提交 → RefundForbiddenException(ORDER_NOT_FOUND)', async () => {
            const booking = await seedBooking();
            await expect(service.submitApply(booking, 'openid-other', '理由')).rejects.toMatchObject({
                code: RefundErrorCode.ORDER_NOT_FOUND,
                status: 403,
            });
        });

        it('未过期订单 → ORDER_NOT_EXPIRED（confirmed 单该走自助退款，不是申请）', async () => {
            const booking = await seedBooking({ status: BookingStatus.CONFIRMED });
            await expectRefundError(
                () => service.submitApply(booking, OPENID, '理由'),
                RefundErrorCode.ORDER_NOT_EXPIRED,
            );
        });

        it('免费预约 → ORDER_IS_FREE', async () => {
            const booking = await seedBooking({ isFree: true, amount: 0 });
            await expectRefundError(
                () => service.submitApply(booking, OPENID, '理由'),
                RefundErrorCode.ORDER_IS_FREE,
            );
        });

        it('未支付 → ORDER_NOT_PAID', async () => {
            const booking = await seedBooking({ paymentStatus: PaymentStatus.UNPAID });
            await expectRefundError(
                () => service.submitApply(booking, OPENID, '理由'),
                RefundErrorCode.ORDER_NOT_PAID,
            );
        });

        it('超过申请时限 → REFUND_DEADLINE_EXCEEDED（显隐之外的硬拦截）', async () => {
            const booking = await seedBooking({
                expiredAt: new Date(Date.now() - (DEADLINE_DAYS + 1) * DAY_MS),
            });
            await expectRefundError(
                () => service.submitApply(booking, OPENID, '理由'),
                RefundErrorCode.REFUND_DEADLINE_EXCEEDED,
            );
        });

        it('过期但缺 expiredAt → REFUND_DEADLINE_UNAVAILABLE（与入口显隐同源：判不出时限就拒绝）', async () => {
            const booking = await seedBooking({ expiredAt: null as any });

            await expectRefundError(
                () => service.submitApply(booking, OPENID, '理由'),
                RefundErrorCode.REFUND_DEADLINE_UNAVAILABLE,
            );
        });

        it('已存在 pending 申请 → REFUND_APPLY_IN_PROGRESS（防重复提交）', async () => {
            const booking = await seedBooking();
            await seedApply(booking, RefundApplyStatus.PENDING);
            await expectRefundError(
                () => service.submitApply(booking, OPENID, '理由'),
                RefundErrorCode.REFUND_APPLY_IN_PROGRESS,
            );
        });

        it('已存在 approved 申请（退款进行中）→ 同样拦截', async () => {
            const booking = await seedBooking();
            await seedApply(booking, RefundApplyStatus.APPROVED);
            await expectRefundError(
                () => service.submitApply(booking, OPENID, '理由'),
                RefundErrorCode.REFUND_APPLY_IN_PROGRESS,
            );
        });

        it('原因只填空格 → 拒绝（trim 后为空不算填了）', async () => {
            const booking = await seedBooking();
            await expectRefundError(
                () => service.submitApply(booking, OPENID, '   '),
                RefundErrorCode.ORDER_NOT_EXPIRED,
            );
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 三、次数与序号语义
    // ─────────────────────────────────────────────────────────────────────────

    describe('次数与序号', () => {
        it('【2026-09-13 决策】**被驳回即终态**：入口关闭，且再次提交被硬拦截', async () => {
            const booking = await seedBooking();

            const first = await service.submitApply(booking, OPENID, '第一次');
            expect(first.applyCount).toBe(1);
            await service.rejectApply(first.applyNo, { adminId: 1, adminName: '张管理' }, '材料不全');

            // 入口不再可见，原因码明确指向「已被驳回」——前端的文案据此引导联系管理员，
            // 而不会出现「重新申请」入口
            const entry = await service.buildRefundEntry(booking);
            expect(entry.visible).toBe(false);
            expect(entry.reason).toBe('APPLY_REJECTED');
            expect(entry.latestApply?.status).toBe(RefundApplyStatus.REJECTED);

            // 服务端硬拦截：显隐只是体验，这条才是边界（旧版小程序/直接调接口都走这里）
            await expectRefundError(
                () => service.submitApply(booking, OPENID, '第二次'),
                RefundErrorCode.REFUND_APPLY_REJECTED,
            );

            // 确认没有落库：序号仍是 1，唯一索引也不会被撞
            const applies = await service.getAppliesForBooking(booking.bookingId);
            expect(applies).toHaveLength(1);
        });

        it('已成功/已失败计入消耗；三条消耗满后拒绝新申请', async () => {
            const booking = await seedBooking();
            await seedApply(booking, RefundApplyStatus.SUCCESS, 1);
            await seedApply(booking, RefundApplyStatus.FAILED, 2);
            await seedApply(booking, RefundApplyStatus.FAILED, 3);

            await expectRefundError(
                () => service.submitApply(booking, OPENID, '第四次'),
                RefundErrorCode.REFUND_APPLY_LIMIT_REACHED,
            );
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 四、审核互斥与幂等
    // ─────────────────────────────────────────────────────────────────────────

    describe('审核', () => {
        it('通过：pending→approved，落审核人与退款单号', async () => {
            const booking = await seedBooking();
            const apply = await service.submitApply(booking, OPENID, '理由');

            const { apply: approved, outRefundNo } = await service.prepareApproval(
                apply.applyNo,
                { adminId: 7, adminName: '李管理' },
                '核实属实',
            );

            expect(approved.status).toBe(RefundApplyStatus.APPROVED);
            expect(approved.auditAdminId).toBe(7);
            expect(approved.auditAdminName).toBe('李管理');
            expect(approved.auditRemark).toBe('核实属实');
            expect(approved.outRefundNo).toBe(outRefundNo);
            expect(outRefundNo).toBe(buildOutRefundNo(booking.bookingId, 1));
        });

        it('并发通过：第二个 prepareApproval 拿到 APPLY_ALREADY_HANDLED（互斥来自条件 UPDATE）', async () => {
            const booking = await seedBooking();
            const apply = await service.submitApply(booking, OPENID, '理由');
            const admin = { adminId: 1, adminName: '管理员' };

            await service.prepareApproval(apply.applyNo, admin);
            await expectRefundError(
                () => service.prepareApproval(apply.applyNo, admin),
                RefundErrorCode.APPLY_ALREADY_HANDLED,
            );
        });

        it('已驳回的单不能再通过', async () => {
            const booking = await seedBooking();
            const apply = await service.submitApply(booking, OPENID, '理由');
            await service.rejectApply(apply.applyNo, { adminId: 1, adminName: '管理员' }, '不符合条件');

            await expectRefundError(
                () => service.prepareApproval(apply.applyNo, { adminId: 2, adminName: '另一个管理员' }),
                RefundErrorCode.APPLY_ALREADY_HANDLED,
            );
        });

        it('驳回：pending→rejected + 拒绝理由必填，且**不改订单状态**', async () => {
            const booking = await seedBooking();
            const apply = await service.submitApply(booking, OPENID, '理由');

            const rejected = await service.rejectApply(
                apply.applyNo,
                { adminId: 3, adminName: '王管理' },
                '该订单已核销',
            );

            expect(rejected.status).toBe(RefundApplyStatus.REJECTED);
            expect(rejected.rejectReason).toBe('该订单已核销');

            const fresh = await bookingRepo.findOne({ where: { bookingId: booking.bookingId } });
            expect(fresh!.status).toBe(BookingStatus.EXPIRED);
            expect(fresh!.refundStatus).toBe(RefundStatus.NONE);
        });

        it('驳回理由为空 → 拒绝该操作，不写库', async () => {
            const booking = await seedBooking();
            const apply = await service.submitApply(booking, OPENID, '理由');

            await expectRefundError(
                () => service.rejectApply(apply.applyNo, { adminId: 1, adminName: '管理员' }, '   '),
                RefundErrorCode.APPLY_ALREADY_HANDLED,
            );
            const fresh = await applyRepo.getByApplyNo(apply.applyNo);
            expect(fresh.status).toBe(RefundApplyStatus.PENDING);
        });

        it('管理员前端不需要把 pending 的拒绝理由当成必填：approve 的 remark 可空', async () => {
            const booking = await seedBooking();
            const apply = await service.submitApply(booking, OPENID, '理由');

            const { apply: approved } = await service.prepareApproval(apply.applyNo, {
                adminId: null,
                adminName: null,
            });
            // 无操作人身份（只带 x-admin-key）：照样能审，审计字段为 null
            expect(approved.status).toBe(RefundApplyStatus.APPROVED);
            expect(approved.auditAdminId).toBeNull();
            expect(approved.auditAdminName).toBeNull();
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 五、资金结果镜像
    // ─────────────────────────────────────────────────────────────────────────

    describe('资金结果镜像', () => {
        it('approved + 退款成功 → success；重复调用是 no-op（回调与对账会同时收敛）', async () => {
            const booking = await seedBooking();
            const apply = await service.submitApply(booking, OPENID, '理由');
            const { outRefundNo } = await service.prepareApproval(apply.applyNo, {
                adminId: 1,
                adminName: '管理员',
            });

            await service.syncSettledByOutRefundNo(outRefundNo, true);
            expect((await applyRepo.getByApplyNo(apply.applyNo)).status).toBe(RefundApplyStatus.SUCCESS);

            // 第二次调用（另一条收敛路径）：状态不变，不抛错
            await service.syncSettledByOutRefundNo(outRefundNo, true);
            expect((await applyRepo.getByApplyNo(apply.applyNo)).status).toBe(RefundApplyStatus.SUCCESS);
        });

        it('approved + 退款终态失败 → failed', async () => {
            const booking = await seedBooking();
            const apply = await service.submitApply(booking, OPENID, '理由');
            const { outRefundNo } = await service.prepareApproval(apply.applyNo, {
                adminId: 1,
                adminName: '管理员',
            });

            await service.syncSettledByOutRefundNo(outRefundNo, false);
            expect((await applyRepo.getByApplyNo(apply.applyNo)).status).toBe(RefundApplyStatus.FAILED);
        });

        it('pending 的单不被资金结果改写（还没审核，钱不该动，单据也不该动）', async () => {
            const booking = await seedBooking();
            const apply = await service.submitApply(booking, OPENID, '理由');
            const outRefundNo = buildOutRefundNo(booking.bookingId, 1);
            // 直接补上单号，模拟「这条退款单确实关联到本申请」
            await applyRawRepo.update({ applyNo: apply.applyNo }, { outRefundNo });

            await service.syncSettledByOutRefundNo(outRefundNo, true);
            expect((await applyRepo.getByApplyNo(apply.applyNo)).status).toBe(RefundApplyStatus.PENDING);
        });

        it('非申请单发起的退款（自助退款/管理员直接退款）→ 静默返回，不抛错', async () => {
            await expect(
                service.syncSettledByOutRefundNo('RF-NOT-FROM-APPLY', true),
            ).resolves.toBeUndefined();
        });

        it('空单号 → 直接返回（历史回调报文可能不带该字段）', async () => {
            await expect(service.syncSettledByOutRefundNo('', true)).resolves.toBeUndefined();
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 六、退款单号换号
    // ─────────────────────────────────────────────────────────────────────────

    describe('退款单号', () => {
        it('第 1 次保持 RF{bookingId} 不变（与历史数据一致），第 2 次起加序号', () => {
            expect(buildOutRefundNo('TL123', 1)).toBe('RFTL123');
            expect(buildOutRefundNo('TL123', 2)).toBe('RFTL123-2');
            expect(buildOutRefundNo('TL123', 3)).toBe('RFTL123-3');
        });

        it('换号是硬要求：同一单第 2 次申请必须拿到不同的 outRefundNo', async () => {
            const booking = await seedBooking();
            const first = await service.submitApply(booking, OPENID, '第一次');
            const firstOut = (await service.prepareApproval(first.applyNo, { adminId: 1, adminName: 'A' }))
                .outRefundNo;
            await service.syncSettledByOutRefundNo(firstOut, false); // 第 1 次退款终态失败

            const second = await service.submitApply(booking, OPENID, '第二次');
            const secondOut = (await service.prepareApproval(second.applyNo, { adminId: 1, adminName: 'A' }))
                .outRefundNo;

            expect(secondOut).not.toBe(firstOut);
            expect(secondOut).toBe(buildOutRefundNo(booking.bookingId, 2));
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 站内信（阶段 4）—— 四个发送点
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * 用**真实的** `MessageService` 跑（不是桩）：这里要验证的正是「业务动作
     * 真的落了一条消息」，桩掉它就只剩「调用了一次方法」，测不到任何东西。
     */
    describe('退款流程的站内信', () => {
        beforeEach(async () => {
            await messageRepo.clear();
        });

        async function messagesOf(): Promise<Message[]> {
            return await messageRepo.find({ where: { userId: OPENID }, order: { id: 'ASC' } });
        }

        it('受理 → 通过 → 到账：三条消息按顺序落下，类型与 dedupeKey 正确', async () => {
            const booking = await seedBooking();
            const apply = await service.submitApply(booking, OPENID, '临时有事');

            let messages = await messagesOf();
            expect(messages.map((m) => m.msgType)).toEqual([MessageType.REFUND_ACCEPTED]);
            expect(messages[0].dedupeKey).toBe(`${MessageType.REFUND_ACCEPTED}:${apply.applyNo}`);

            const { outRefundNo } = await service.prepareApproval(apply.applyNo, {
                adminId: 1,
                adminName: 'A',
            });
            messages = await messagesOf();
            expect(messages.map((m) => m.msgType)).toEqual([
                MessageType.REFUND_ACCEPTED,
                MessageType.REFUND_APPROVED,
            ]);

            await service.syncSettledByOutRefundNo(outRefundNo, true);
            messages = await messagesOf();
            expect(messages.map((m) => m.msgType)).toEqual([
                MessageType.REFUND_ACCEPTED,
                MessageType.REFUND_APPROVED,
                MessageType.REFUND_SUCCESS,
            ]);
            // 金额取申请单快照（分 → 元）
            expect(messages[2].title).toContain('50.00');
        });

        it('驳回：理由**原样**出现在标题与正文里', async () => {
            const booking = await seedBooking();
            const apply = await service.submitApply(booking, OPENID, '临时有事');

            await service.rejectApply(apply.applyNo, { adminId: 1, adminName: 'A' }, '订单已核销，不能退款');

            const rejected = (await messagesOf()).find((m) => m.msgType === MessageType.REFUND_REJECTED);
            expect(rejected).toBeDefined();
            expect(rejected!.title).toContain('订单已核销，不能退款');
            expect(rejected!.content).toContain('订单已核销，不能退款');
        });

        it('**同一订单第 2 次申请仍能收到审核结果**（v1 缺陷回归）', async () => {
            // v1 用订单号做 dedupeKey，第 2、3 次申请的消息与第 1 次 key 相同，
            // 被静默去重——用户提交了申请却永远收不到结果。这是 v2 最重要的一条修正。
            //
            // 重提路径：驳回已是终态（2026-09-13 决策），**只剩「审核通过 → 资金执行失败 → 再申请」**
            // 这一条能产生第 2 次申请。所以这里用 failed 构造，而不是驳回——
            // 被测的仍然是「第 2 次申请的消息不能被第 1 次的 key 吞掉」。
            const booking = await seedBooking();

            const first = await service.submitApply(booking, OPENID, '第一次');
            const firstApproved = await service.prepareApproval(first.applyNo, {
                adminId: 1,
                adminName: 'A',
            });
            // 微信侧终态失败（余额不足等），单据镜像为 failed
            await service.syncSettledByOutRefundNo(firstApproved.outRefundNo, false);

            const second = await service.submitApply(booking, OPENID, '第二次');
            await service.prepareApproval(second.applyNo, { adminId: 1, adminName: 'A' });
            const secondApproved = await service.syncSettledByOutRefundNo(
                buildOutRefundNo(booking.bookingId, 2),
                true,
            );

            // 第 2 次申请的「受理 + 通过」两条消息都在，且 key 指向各自的申请单号
            const accepted = (await messagesOf()).filter(
                (m) => m.msgType === MessageType.REFUND_ACCEPTED,
            );
            expect(accepted.map((m) => m.dedupeKey)).toEqual([
                `${MessageType.REFUND_ACCEPTED}:${first.applyNo}`,
                `${MessageType.REFUND_ACCEPTED}:${second.applyNo}`,
            ]);
            const approved = (await messagesOf()).filter(
                (m) => m.msgType === MessageType.REFUND_APPROVED,
            );
            expect(approved.map((m) => m.dedupeKey)).toEqual([
                `${MessageType.REFUND_APPROVED}:${first.applyNo}`,
                `${MessageType.REFUND_APPROVED}:${second.applyNo}`,
            ]);
            expect(approved.map((m) => m.bizId)).toEqual([first.applyNo, second.applyNo]);
            expect(second.applyCount).toBe(2);
            expect(secondApproved).toBeUndefined(); // syncSettledByOutRefundNo 无返回值
        });

        it('到账消息只在**本次真的推动了状态**时发出（回调与对账重复收敛不会重复通知）', async () => {
            const booking = await seedBooking();
            const apply = await service.submitApply(booking, OPENID, '临时有事');
            const { outRefundNo } = await service.prepareApproval(apply.applyNo, {
                adminId: 1,
                adminName: 'A',
            });

            await service.syncSettledByOutRefundNo(outRefundNo, true);
            await service.syncSettledByOutRefundNo(outRefundNo, true); // 15 分钟对账再来一次
            await service.syncSettledByOutRefundNo(outRefundNo, true); // 异常通道又来一次

            const successes = (await messagesOf()).filter(
                (m) => m.msgType === MessageType.REFUND_SUCCESS,
            );
            expect(successes).toHaveLength(1);
        });

        it('退款**失败**不发站内信（需要人工介入，让管理员沟通）', async () => {
            const booking = await seedBooking();
            const apply = await service.submitApply(booking, OPENID, '临时有事');
            const { outRefundNo } = await service.prepareApproval(apply.applyNo, {
                adminId: 1,
                adminName: 'A',
            });

            await service.syncSettledByOutRefundNo(outRefundNo, false);

            const types = (await messagesOf()).map((m) => m.msgType);
            expect(types).not.toContain(MessageType.REFUND_SUCCESS);
        });

        it('非「申请→审核」路径产生的退款单（查不到申请单）静默跳过', async () => {
            await expect(
                service.syncSettledByOutRefundNo('RF-NOT-AN-APPLY', true),
            ).resolves.toBeUndefined();
            expect(await messagesOf()).toHaveLength(0);
        });

        it('站内信写失败**不会**让申请提交失败（通知不反噬主流程）', async () => {
            // 用真实 MessageService 无法制造写失败，这里换成一个必抛的实现：
            // 若通知没有被兜住，submitApply 会跟着抛，用户看到「申请失败」
            // ——而申请单其实已经落库了，用户重试还会撞上「请勿重复提交」。
            const original = messageService.send.bind(messageService);
            (messageService as any).send = () => {
                throw new Error('messages 表写入失败');
            };
            try {
                const booking = await seedBooking();
                const apply = await service.submitApply(booking, OPENID, '临时有事');
                expect(apply.status).toBe(RefundApplyStatus.PENDING);
            } finally {
                (messageService as any).send = original;
            }
        });
    });
});
