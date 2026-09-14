import { Test } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
    Booking,
    BookingStatus,
    PaymentStatus,
    RefundStatus,
    TimeSlot,
    TravelMode,
} from '../../entities/booking.entity';
import { BookingAnomaly } from '../../entities/booking-anomaly.entity';
import { AnomalyStatus } from '../../entities/booking-anomaly.entity';
import { RefundApply, RefundApplyStatus } from '../../entities/refund-apply.entity';
import { Message, MessageType } from '../../entities/message.entity';
import { BookingRepository } from '../../repositories/booking.repository';
import { RefundApplyRepository } from '../../repositories/refund-apply.repository';
import { MessageRepository } from '../../repositories/message.repository';
import { SystemConfigService } from '../system-config/system-config.service';
import { MessageService } from '../message/message.service';
import { RefundApplyService } from './refund-apply.service';
import { BookingService } from '../booking/booking.service';
import { WechatPayService } from '../wechat-pay/wechat-pay.service';

/**
 * 「退款到账」通知的**三条资金收敛路径**都必须发得出去
 *
 * ── 这个文件是为一个已经发生过的缺陷写的 ────────────────────────────────────
 * 同一笔退款会被三条路径收敛：
 *   ① 微信回调        `WechatPayService.handleRefundCallback`
 *   ② 15 分钟退款对账 `BookingService.applyRefundReconcileResult`
 *   ③ 异常通道重试    `BookingService.applyAnomalyAction`
 *
 * 三处各有**自己私有的** `mirrorRefundSettlement`，它们直接调 `markSettled` 而
 * 不经过 `RefundApplyService`（为避免模块环，见 wechat-pay.module.ts 的注释）。
 * 因此把到账通知写在 `RefundApplyService.syncSettledByOutRefundNo` 里，
 * 结果是：**单元测试全绿（那条路径确实会发），而线上真实回调一条也发不出去**。
 * 这个文件把三处都盖住，任何一处漏掉通知都会红灯。
 *
 * ── 为什么用 `as any` 调私有方法 ────────────────────────────────────────────
 * 三个 `mirrorRefundSettlement` 都是私有的，且它们唯一的公开入口要么需要微信证书
 * （`handleRefundCallback` 要验签），要么由 Cron 驱动（对账/异常任务）。
 * 为了这三个断言去搭一套微信验签夹具，成本远高于收益，而且测到的是夹具不是代码。
 * 直接调私有方法是**刻意的取舍**：这些方法小且稳定，本文件锁的是「它有没有发通知」，
 * 不是它的内部实现。若将来它被重命名，这里会编译失败——那是提醒，不是障碍。
 *
 * 夹具均为虚构数据，不含真实用户信息。
 */
describe('退款到账通知的三条镜像路径', () => {
    let refundApplyService: RefundApplyService;
    let bookingService: BookingService;
    let wechatPayService: WechatPayService;
    let bookingRepo: Repository<Booking>;
    let applyRepo: Repository<RefundApply>;
    let messageRepo: Repository<Message>;

    const OPENID = 'openid-settle-a';
    const AMOUNT = 5000;

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
                RefundApplyService,
                { provide: SystemConfigService, useValue: { getRefundApplyDeadlineDays: () => 7 } },
            ],
        }).compile();

        const bookingRepository = moduleRef.get(BookingRepository);
        const refundApplyRepository = moduleRef.get(RefundApplyRepository);
        const messageService = moduleRef.get(MessageService);

        bookingRepo = moduleRef.get(getRepositoryToken(Booking));
        applyRepo = moduleRef.get(getRepositoryToken(RefundApply));
        messageRepo = moduleRef.get(getRepositoryToken(Message));

        refundApplyService = moduleRef.get(RefundApplyService);

        bookingService = new BookingService(
            bookingRepository,
            null as any, // wechatPayService —— 本文件不触达
            null as any, // systemConfigService
            null as any, // adminApplicationRepository
            null as any, // dataSource
            null as any, // memberService
            null as any, // userProfileRepository
            { write: () => undefined } as any, // loggingService
            refundApplyRepository,
            messageService,
        );

        // 构造即 `init()`：本机无 `certs/apiclient_key.pem`，会打一条 error 日志后
        // 停在未初始化状态——本文件只用它的私有镜像方法，不发任何微信请求
        wechatPayService = new WechatPayService(
            bookingRepo,
            bookingRepository,
            refundApplyRepository,
            messageService,
        );
    });

    beforeEach(async () => {
        await messageRepo.clear();
        await applyRepo.clear();
        await bookingRepo.clear();
    });

    let seq = 0;
    /**
     * 造一张「已审核通过、等待资金结果」的申请单（`markSettled` 只对 approved 生效）
     *
     * @param outTradeNo 微信支付单号。`handleRefundCallback` 是按它反查订单的，
     *        只有走回调路径的用例需要传
     */
    async function seedApprovedApply(outRefundNo: string, outTradeNo?: string): Promise<RefundApply> {
        seq += 1;
        const booking = await bookingRepo.save(
            bookingRepo.create({
                bookingId: `TL-SETTLE-${seq}`,
                wechatOpenId: OPENID,
                name: '测试',
                phone: '13800000000',
                bookingDate: new Date('2026-09-01T00:00:00') as any,
                timeSlot: TimeSlot.MORNING,
                travelMode: TravelMode.SELF_DRIVING,
                personCount: 1,
                remarks: '',
                isFree: false,
                amount: AMOUNT,
                status: BookingStatus.EXPIRED,
                paymentStatus: PaymentStatus.PAID,
                refundStatus: RefundStatus.REFUNDING,
                outRefundNo,
                outTradeNo,
                expiredAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
            }),
        );

        return await applyRepo.save(
            applyRepo.create({
                applyNo: `RA-SETTLE-${seq}`,
                bookingId: booking.bookingId,
                wechatOpenId: OPENID,
                applyCount: 1,
                reason: '临时有事',
                status: RefundApplyStatus.APPROVED,
                refundAmount: AMOUNT,
                outRefundNo,
            }),
        );
    }

    async function successMessages(): Promise<Message[]> {
        return await messageRepo.find({
            where: { userId: OPENID, msgType: MessageType.REFUND_SUCCESS },
        });
    }

    /** 三条路径的入口（私有方法，理由见文件头注释） */
    const refundServicePath = (outRefundNo: string, success: boolean) =>
        refundApplyService.syncSettledByOutRefundNo(outRefundNo, success);
    const bookingPath = (outRefundNo: string, success: boolean) =>
        (bookingService as any).mirrorRefundSettlement(outRefundNo, success);
    const wechatPayPath = (outRefundNo: string, success: boolean) =>
        (wechatPayService as any).mirrorRefundSettlement(outRefundNo, success);

    const PATHS: Array<[string, (outRefundNo: string, success: boolean) => Promise<unknown>]> = [
        ['RefundApplyService.syncSettledByOutRefundNo', refundServicePath],
        ['BookingService（对账 / 异常通道）', bookingPath],
        ['WechatPayService（微信回调）', wechatPayPath],
    ];

    it.each(PATHS)('%s 发出「退款已到账」站内信', async (_name, run) => {
        const apply = await seedApprovedApply('RF-SETTLE-1');

        await run('RF-SETTLE-1', true);

        const messages = await successMessages();
        expect(messages).toHaveLength(1);
        expect(messages[0].dedupeKey).toBe(`${MessageType.REFUND_SUCCESS}:${apply.applyNo}`);
        expect(messages[0].bizId).toBe(apply.applyNo);
        expect(messages[0].title).toContain('50.00'); // 金额取申请单快照（分 → 元）
    });

    it.each(PATHS)('%s 在退款**失败**时不发消息', async (_name, run) => {
        await seedApprovedApply('RF-SETTLE-2');

        await run('RF-SETTLE-2', false);

        expect(await successMessages()).toHaveLength(0);
    });

    it('三条路径并发收敛同一笔退款 → 只发一条（先到者 affected=1）', async () => {
        await seedApprovedApply('RF-SETTLE-3');

        // 顺序调用模拟「回调先到、对账与异常通道后到」——后两者 markSettled 拿 0
        await wechatPayPath('RF-SETTLE-3', true);
        await bookingPath('RF-SETTLE-3', true);
        await refundServicePath('RF-SETTLE-3', true);

        expect(await successMessages()).toHaveLength(1);
    });

    it('反查不到申请单（自助退款 / 管理员直接退款）时静默跳过，不报错也不发消息', async () => {
        for (const [, run] of PATHS) {
            await expect(run('RF-NOT-AN-APPLY', true)).resolves.not.toThrow();
        }
        expect(await successMessages()).toHaveLength(0);

        // 空单号：历史回调报文可能不带该字段
        await expect(bookingPath('', true)).resolves.not.toThrow();
        await expect(wechatPayPath('', true)).resolves.not.toThrow();
        expect(await successMessages()).toHaveLength(0);
    });

    it('站内信写失败不会让资金收敛失败（通知不反噬主流程）', async () => {
        // 微信回调里抛异常 → 回调返回失败 → 微信重推。通知不是业务结果，
        // 写不进去不该让一次已经成功的退款回调变成失败。
        await seedApprovedApply('RF-SETTLE-4');
        const messageService = (refundApplyService as any).messageService as MessageService;
        const original = messageService.send.bind(messageService);
        (messageService as any).send = () => {
            throw new Error('messages 表写入失败');
        };
        try {
            await expect(wechatPayPath('RF-SETTLE-4', true)).resolves.not.toThrow();
            // 申请单本身仍然被正确置为终态
            const after = await applyRepo.findOne({ where: { outRefundNo: 'RF-SETTLE-4' } });
            expect(after!.status).toBe(RefundApplyStatus.SUCCESS);
        } finally {
            (messageService as any).send = original;
        }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 微信退款「异常」（ABNORMAL）是**非终态** —— 2026-09-13 修正
    //
    // 判成终态失败的后果不是「多一条失败记录」，而是**重复退款**：
    // 用户看到失败会重新申请（驳回虽已终态，但 failed 仍允许重提）→ 换号重发 RF{id}-2，
    // 而第一笔在微信侧补足余额后仍可能成功。旧实现靠固定单号 + 微信幂等天然不可能退两次，
    // 换号之后这个保护没了，只能靠「不判终态」兜住。见 implementation-todo.md 说明 33。
    // ─────────────────────────────────────────────────────────────────────────
    describe('微信退款异常（ABNORMAL）', () => {
        async function anomaliesOf(bookingId: string) {
            return await bookingRepo.manager.find(BookingAnomaly, { where: { bookingId } });
        }

        it('回调 ABNORMAL **不判终态失败**：订单保持 refunding、单据保持 approved、记一条异常', async () => {
            const apply = await seedApprovedApply('RF-ABNORMAL-1', 'OT-ABNORMAL-1');

            await wechatPayService.handleRefundCallback('OT-ABNORMAL-1', 'ABNORMAL', 'RF-ABNORMAL-1');

            const booking = await bookingRepo.findOneOrFail({ where: { bookingId: apply.bookingId } });
            expect(booking.refundStatus).toBe(RefundStatus.REFUNDING); // 不是 failed
            expect(booking.reconcileKind).toBe('refund'); // 对账继续跑，等它自愈或转人工
            expect(booking.reconcileLastErrorCode).toBe('REFUND_ABNORMAL');

            const after = await applyRepo.findOneOrFail({ where: { applyNo: apply.applyNo } });
            expect(after.status).toBe(RefundApplyStatus.APPROVED); // 没被镜像成 failed

            const anomalies = await anomaliesOf(apply.bookingId);
            expect(anomalies).toHaveLength(1);
            expect(anomalies[0].status).toBe(AnomalyStatus.OPEN);
            expect(anomalies[0].lastErrorCode).toBe('REFUND_ABNORMAL');
            expect(anomalies[0].lastErrorSummary).toContain('余额'); // 给运营的排查方向

            expect(await successMessages()).toHaveLength(0); // 钱没到，不发到账通知
        });

        it('对照：CLOSED 仍是终态失败（别把 ABNORMAL 的改动扩大成"什么都不判失败"）', async () => {
            const apply = await seedApprovedApply('RF-CLOSED-1', 'OT-CLOSED-1');

            await wechatPayService.handleRefundCallback('OT-CLOSED-1', 'CLOSED', 'RF-CLOSED-1');

            const booking = await bookingRepo.findOneOrFail({ where: { bookingId: apply.bookingId } });
            expect(booking.refundStatus).toBe(RefundStatus.FAILED);

            const after = await applyRepo.findOneOrFail({ where: { applyNo: apply.applyNo } });
            expect(after.status).toBe(RefundApplyStatus.FAILED); // 单据镜像为 failed
        });
    });
});
