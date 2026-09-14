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
import { Message, MessageType, OaSendStatus } from '../../entities/message.entity';
import { BookingRepository } from '../../repositories/booking.repository';
import { MessageRepository } from '../../repositories/message.repository';
import { MessageService } from '../message/message.service';
import { MESSAGE_QUIET_WINDOW_MS, MESSAGE_SCAN_BATCH_LIMIT } from '../message/message-policy';
import { BookingService } from './booking.service';
import { beijingDateStr } from '../../common/date-utils';

/**
 * T1 步骤② / T2 每日提醒的**发送行为**测试（阶段 4）
 *
 * ── 为什么单独一个文件 ────────────────────────────────────────────────────
 * `booking-expire.spec.ts` 覆盖的是**状态流转**（`markExpired` 与 `markVerified` 互斥），
 * 那里传入的协作者全是 null——它锁的是「谁先成功谁生效」。
 * 本文件覆盖的是发送：什么时候发、发几条、什么时候**不**写标记位。
 * 两件事的失败模式完全不同，混在一个文件里会让「发通知挂了但状态流转正常」这种
 * 事故看起来像状态流转的锅。
 *
 * ── 锁定的核心不变式 ──────────────────────────────────────────────────────
 *   1. **A 规则（≥2h）不满足时不写 `expireNotifiedAt`**——否则用户永远收不到，
 *      而库里显示"已通知"。这是标记位方案唯一可能失效的方式，也是本文件最重要的一条；
 *   2. **被每日配额挡下时不写标记位**——同理，次日额度重置后必须还能补发；
 *   3. **去重命中（T2 ② 已经发过）时仍写标记位**——否则那条订单每小时被重扫一次，
 *      永远消化不掉，积压队列的队头会被它一个人堵死；
 *   4. **`ORDER_EXPIRED` 的两条路径（T1 ② / T2 ②）共用 dedupeKey**——用户不会收到两条；
 *   5. **T2 ① 的提醒不会发给当天刚下单的人**（A 规则），当天订单次日不再被扫到；
 *   6. **`refundStatus != none` 的订单不再推「可申请退款」**——文案与事实矛盾；
 *   7. **站内信正文里的申请截止日与退款入口用同一个公式**（`refund-deadline.ts`）。
 *
 * 时间基准：`runExpireScan` / `runDailyReminderScan` 内部取 `Date.now()`，
 * 注入不了，故本文件的夹具一律**相对当前时刻**构造（`ago(ms)`），
 * 断言里的期望值用本文件自带的独立算法算出——**不 import 生产实现**，
 * 否则测的是「自己等于自己」。测试因此不会随时间失效。
 *
 * 夹具均为虚构数据，不含真实用户信息。
 */
describe('阶段 4 扫描类通知（T1 ② / T2）', () => {
    let service: BookingService;
    let bookingRepository: BookingRepository;
    let messageService: MessageService;
    let bookingRepo: Repository<Booking>;
    let messageRepo: Repository<Message>;

    const DEADLINE_DAYS = 7;
    const USER = 'openid-notify-a';

    /** 当前时刻往前 `ms` 毫秒 */
    const ago = (ms: number) => new Date(Date.now() - ms);
    const HOUR = 60 * 60 * 1000;
    const DAY = 24 * HOUR;

    /**
     * 独立的期望值算法（不复用 `beijingDateStr`）
     *
     * 北京日 = epoch + 8h 后取 ISO 前缀。这里重写一遍是**刻意的**：
     * 若与生产实现共用同一个函数，"截止日算对了吗" 这个问题就变成了自证。
     */
    function expectedDeadlineStr(expiredAtMs: number, days: number): string {
        return new Date(expiredAtMs + days * DAY + 8 * HOUR).toISOString().substring(0, 10);
    }

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({
            imports: [
                TypeOrmModule.forRoot({
                    type: 'sqlite',
                    database: ':memory:',
                    synchronize: true,
                    dropSchema: true,
                    entities: [Booking, BookingAnomaly, Message],
                }),
                TypeOrmModule.forFeature([Booking, BookingAnomaly, Message]),
            ],
            providers: [BookingRepository, MessageRepository, MessageService],
        }).compile();

        bookingRepository = moduleRef.get(BookingRepository);
        messageService = moduleRef.get(MessageService);
        bookingRepo = moduleRef.get(getRepositoryToken(Booking));
        messageRepo = moduleRef.get(getRepositoryToken(Message));

        service = new BookingService(
            bookingRepository,
            null as any, // wechatPayService —— 本文件不触达
            {
                // 只实现被发送路径用到的这一个方法：其余方法缺失时会在调用处抛
                // "is not a function"，比返回 undefined 更早暴露
                getRefundApplyDeadlineDays: () => DEADLINE_DAYS,
            } as any,
            null as any, // adminApplicationRepository
            null as any, // dataSource
            null as any, // memberService
            null as any, // userProfileRepository
            { write: () => undefined } as any, // loggingService（logTask 只写日志）
            null as any, // refundApplyRepository
            messageService,
        );
    });

    beforeEach(async () => {
        await messageRepo.clear();
        await bookingRepo.clear();
    });

    let seq = 0;
    async function seedBooking(over: Partial<Booking> = {}): Promise<Booking> {
        seq += 1;
        return await bookingRepo.save(
            bookingRepo.create({
                bookingId: `TL-NOTIFY-${seq}`,
                wechatOpenId: USER,
                name: '测试',
                phone: '13800000000',
                bookingDate: new Date(`${beijingDateStr()}T00:00:00`) as any,
                timeSlot: TimeSlot.MORNING,
                travelMode: TravelMode.SELF_DRIVING,
                personCount: 1,
                remarks: '',
                isFree: false,
                amount: 10000,
                status: BookingStatus.CONFIRMED,
                paymentStatus: PaymentStatus.PAID,
                refundStatus: RefundStatus.NONE,
                createdAt: ago(3 * HOUR),
                updatedAt: ago(3 * HOUR),
                ...over,
            }),
        );
    }

    /** 某订单当前落库的 `expireNotifiedAt`（原始列值，绕过 transformer） */
    async function notifiedAtOf(bookingId: string): Promise<number | null> {
        const rows = await bookingRepo.query(
            'SELECT expireNotifiedAt FROM bookings WHERE bookingId = ?',
            [bookingId],
        );
        return rows[0]?.expireNotifiedAt ?? null;
    }

    async function messagesOf(userId = USER): Promise<Message[]> {
        return await messageRepo.find({
            where: { userId },
            order: { id: 'ASC' },
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // T1 步骤②
    // ─────────────────────────────────────────────────────────────────────────

    describe('T1 步骤②（已过期但未通知）', () => {
        it('已过期且满足 A 规则 → 发出通知并写标记位；再跑一轮不重复发', async () => {
            const expiredAt = ago(1 * DAY);
            const booking = await seedBooking({
                status: BookingStatus.EXPIRED,
                expiredAt,
            });

            await service.runExpireScan();

            const messages = await messagesOf();
            expect(messages).toHaveLength(1);
            expect(messages[0].msgType).toBe(MessageType.ORDER_EXPIRED);
            expect(messages[0].bizId).toBe(booking.bookingId);
            // 截止日 = expiredAt + 7 天（北京日），与退款入口同一个公式
            expect(messages[0].content).toContain(
                `申请截止：${expectedDeadlineStr(expiredAt.getTime(), DEADLINE_DAYS)}。`,
            );
            expect(messages[0].jumpPath).toContain('focus=refund');
            expect(await notifiedAtOf(booking.bookingId)).not.toBeNull();

            // 第二轮：标记位生效，既不重发也不重复写
            await service.runExpireScan();
            expect(await messagesOf()).toHaveLength(1);
        });

        it('A 规则不满足（下单不足 2 小时）→ **不写标记位**，到期后自动补发', async () => {
            // 这是标记位方案唯一可能失效的方式：写了标记位 = 这条通知永远发不出去，
            // 而库里显示"已通知"。所以「不发」与「不写标记位」必须同时成立。
            const booking = await seedBooking({
                status: BookingStatus.EXPIRED,
                expiredAt: ago(1 * HOUR),
                createdAt: ago(1 * HOUR), // 不足 2 小时
            });

            await service.runExpireScan();
            expect(await messagesOf()).toHaveLength(0);
            expect(await notifiedAtOf(booking.bookingId)).toBeNull();

            // 把下单时间改到 3 小时前（等价于"时间流逝到满足 A 规则"），下一轮补发
            await bookingRepo.update({ bookingId: booking.bookingId }, { createdAt: ago(3 * HOUR) });
            await service.runExpireScan();

            expect(await messagesOf()).toHaveLength(1);
            expect(await notifiedAtOf(booking.bookingId)).not.toBeNull();
        });

        it('每日配额挡住时**不写标记位**，次日额度重置后补发', async () => {
            // 先用满当天 5 条额度（上限由 MESSAGE_DAILY_LIMIT 决定，默认 5）
            for (let i = 0; i < 5; i++) {
                await messageRepo.save(
                    messageRepo.create({
                        userId: USER,
                        msgType: MessageType.ORDER_EXPIRE_REMINDER,
                        title: '占额度',
                        content: '占额度',
                        dedupeKey: `quota:${i}`,
                        senderType: 'SYSTEM',
                        oaSendStatus: OaSendStatus.SKIPPED,
                        oaAttempts: 0,
                        isRead: 0,
                        createdAt: new Date(),
                        updatedAt: new Date(),
                    }),
                );
            }

            const booking = await seedBooking({ status: BookingStatus.EXPIRED, expiredAt: ago(1 * DAY) });

            await service.runExpireScan();

            expect(await messagesOf()).toHaveLength(5); // 只有占额度的那 5 条
            expect(await notifiedAtOf(booking.bookingId)).toBeNull(); // ← 关键：没写标记位
        });

        it('去重命中（同 key 已存在）时**仍然写标记位**，否则队头会被永久堵死', async () => {
            const booking = await seedBooking({ status: BookingStatus.EXPIRED, expiredAt: ago(1 * DAY) });

            // 模拟 T2 ② 已经发过同一条（两条路径共用 ORDER_EXPIRED:{bookingId}）
            await messageRepo.save(
                messageRepo.create({
                    userId: USER,
                    msgType: MessageType.ORDER_EXPIRED,
                    title: '已由 T2 发出',
                    content: '正文',
                    dedupeKey: `${MessageType.ORDER_EXPIRED}:${booking.bookingId}`,
                    senderType: 'SYSTEM',
                    oaSendStatus: OaSendStatus.SKIPPED,
                    oaAttempts: 0,
                    isRead: 0,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                }),
            );

            await service.runExpireScan();

            expect(await messagesOf()).toHaveLength(1); // 没有第二条
            expect(await notifiedAtOf(booking.bookingId)).not.toBeNull(); // 但标记位要写上
        });

        it('confirmed 的订单不会被 T1 ② 当成过期单发通知', async () => {
            await seedBooking({ status: BookingStatus.CONFIRMED });

            await service.runExpireScan();

            expect(await messagesOf()).toHaveLength(0);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 候选查询（不走 cron，直接锁谓词与排序/批量）
    // ─────────────────────────────────────────────────────────────────────────

    describe('findExpiredNotNotified（谓词、排序、批量）', () => {
        it('按 expiredAt 升序取，积压时先补发过期最久的', async () => {
            const older = await seedBooking({ status: BookingStatus.EXPIRED, expiredAt: ago(3 * DAY) });
            const newer = await seedBooking({ status: BookingStatus.EXPIRED, expiredAt: ago(1 * DAY) });

            const rows = await bookingRepository.findExpiredNotNotified(10, Date.now(), MESSAGE_QUIET_WINDOW_MS);

            expect(rows.map((r) => r.bookingId)).toEqual([older.bookingId, newer.bookingId]);
        });

        it('limit 生效：单轮不会把所有积压一次性发出去', async () => {
            for (let i = 0; i < 3; i++) {
                await seedBooking({ status: BookingStatus.EXPIRED, expiredAt: ago((i + 1) * DAY) });
            }

            const rows = await bookingRepository.findExpiredNotNotified(2, Date.now(), MESSAGE_QUIET_WINDOW_MS);

            expect(rows).toHaveLength(2);
            expect(MESSAGE_SCAN_BATCH_LIMIT).toBeGreaterThan(2); // 批量上限是独立的常量
        });

        it('已写过标记位的不再被取到', async () => {
            const booking = await seedBooking({ status: BookingStatus.EXPIRED, expiredAt: ago(1 * DAY) });
            await bookingRepository.markExpireNotified(booking.bookingId, Date.now());

            expect(await bookingRepository.findExpiredNotNotified(10, Date.now(), MESSAGE_QUIET_WINDOW_MS)).toHaveLength(0);
        });

        it('markExpireNotified 带 IS NULL 条件：重复调用只有第一次 affected=1', async () => {
            const booking = await seedBooking({ status: BookingStatus.EXPIRED, expiredAt: ago(1 * DAY) });

            expect(await bookingRepository.markExpireNotified(booking.bookingId, Date.now())).toBe(1);
            expect(await bookingRepository.markExpireNotified(booking.bookingId, Date.now())).toBe(0);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // T2
    // ─────────────────────────────────────────────────────────────────────────

    describe('T2 每日 22:00 双扫描', () => {
        it('① 当天未核销 → 提醒核销；重复跑不重复发（dedupeKey 兜底）', async () => {
            const booking = await seedBooking({
                status: BookingStatus.CONFIRMED,
                bookingDate: new Date(`${beijingDateStr()}T00:00:00`) as any,
                createdAt: ago(3 * HOUR),
            });

            await service.runDailyReminderScan();

            const messages = await messagesOf();
            expect(messages).toHaveLength(1);
            expect(messages[0].msgType).toBe(MessageType.ORDER_EXPIRE_REMINDER);
            expect(messages[0].dedupeKey).toBe(
                `${MessageType.ORDER_EXPIRE_REMINDER}:${booking.bookingId}`,
            );

            await service.runDailyReminderScan();
            expect(await messagesOf()).toHaveLength(1);
        });

        it('① 当天刚下单的人当晚不推（A 规则）', async () => {
            await seedBooking({
                status: BookingStatus.CONFIRMED,
                bookingDate: new Date(`${beijingDateStr()}T00:00:00`) as any,
                createdAt: ago(30 * 60 * 1000), // 半小时前
            });

            await service.runDailyReminderScan();

            expect(await messagesOf()).toHaveLength(0);
        });

        it('① 不提醒其他日期的订单（昨天的、明天的都不管）', async () => {
            const yesterday = new Date(Date.now() - DAY + 8 * HOUR).toISOString().substring(0, 10);
            const tomorrow = new Date(Date.now() + DAY + 8 * HOUR).toISOString().substring(0, 10);
            await seedBooking({
                status: BookingStatus.CONFIRMED,
                bookingDate: new Date(`${yesterday}T00:00:00`) as any,
            });
            await seedBooking({
                status: BookingStatus.CONFIRMED,
                bookingDate: new Date(`${tomorrow}T00:00:00`) as any,
            });

            await service.runDailyReminderScan();

            expect(await messagesOf()).toHaveLength(0);
        });

        it('② 近 7 天已过期未通知 → 发「可申请退款」+ 写标记位（兜底 T1 的漏发）', async () => {
            const booking = await seedBooking({ status: BookingStatus.EXPIRED, expiredAt: ago(2 * DAY) });

            await service.runDailyReminderScan();

            const messages = await messagesOf();
            expect(messages).toHaveLength(1);
            expect(messages[0].msgType).toBe(MessageType.ORDER_EXPIRED);
            expect(await notifiedAtOf(booking.bookingId)).not.toBeNull();
        });

        it('② 已提交退款申请的（refunding）不再推「可申请退款」，也不写标记位', async () => {
            const booking = await seedBooking({
                status: BookingStatus.EXPIRED,
                expiredAt: ago(2 * DAY),
                refundStatus: RefundStatus.REFUNDING,
            });

            await service.runDailyReminderScan();

            expect(await messagesOf()).toHaveLength(0);
            // 不写标记位：退款失败回到 none 时仍应提醒
            expect(await notifiedAtOf(booking.bookingId)).toBeNull();
        });

        it('② 超出 7 天窗口的不再提醒（与退款申请时限同源）', async () => {
            await seedBooking({
                status: BookingStatus.EXPIRED,
                expiredAt: ago((DEADLINE_DAYS + 1) * DAY),
            });

            await service.runDailyReminderScan();

            expect(await messagesOf()).toHaveLength(0);
        });

        it('② 与 T1 ② 共用 dedupeKey：T1 已发过的，T2 不再发第二条', async () => {
            const booking = await seedBooking({ status: BookingStatus.EXPIRED, expiredAt: ago(2 * DAY) });

            await service.runExpireScan();
            expect(await messagesOf()).toHaveLength(1);

            await service.runDailyReminderScan();
            expect(await messagesOf()).toHaveLength(1);
        });

        it('① 与 ② 互不干扰：当天未核销的走提醒，已过期的走可退款', async () => {
            await seedBooking({
                status: BookingStatus.CONFIRMED,
                bookingDate: new Date(`${beijingDateStr()}T00:00:00`) as any,
                createdAt: ago(3 * HOUR),
            });
            await seedBooking({ status: BookingStatus.EXPIRED, expiredAt: ago(2 * DAY) });

            await service.runDailyReminderScan();

            const types = (await messagesOf()).map((m) => m.msgType).sort();
            expect(types).toEqual([MessageType.ORDER_EXPIRED, MessageType.ORDER_EXPIRE_REMINDER]);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 手动触发的静默期覆盖（POST /admin/tasks/* 的 quietWindowMinutes）
    //
    // 这组用例锁的是「能覆盖，但只覆盖这一次，且 cron 路径不受影响」。
    // 覆盖是给测试用的：不覆盖的话，「下单 → 过期 → 收通知」这条链路要干等 2 小时，
    // 一遍都验不完。
    // ─────────────────────────────────────────────────────────────────────────

    describe('静默期覆盖（只有手动触发能传）', () => {
        it('不传 = A 规则 2 小时：半小时前下单的过期单不会被扫到', async () => {
            const booking = await seedBooking({
                status: BookingStatus.EXPIRED,
                expiredAt: ago(30 * 60 * 1000),
                createdAt: ago(30 * 60 * 1000),
            });

            const result = await service.runExpireScan();

            expect(await messagesOf()).toHaveLength(0);
            expect(await notifiedAtOf(booking.bookingId)).toBeNull();
            expect(result.quietWindowMinutes).toBe(120);
        });

        it('传 0 = 不设静默期：同一张单立刻被扫到并发出通知', async () => {
            const booking = await seedBooking({
                status: BookingStatus.EXPIRED,
                expiredAt: ago(30 * 60 * 1000),
                createdAt: ago(30 * 60 * 1000),
            });

            const result = await service.runExpireScan({ quietWindowMs: 0 });

            expect(await messagesOf()).toHaveLength(1);
            expect(await notifiedAtOf(booking.bookingId)).not.toBeNull();
            expect(result.quietWindowMinutes).toBe(0);
        });

        it('覆盖只作用于本次：下一次不传时仍按 2 小时走', async () => {
            await seedBooking({
                status: BookingStatus.EXPIRED,
                expiredAt: ago(30 * 60 * 1000),
                createdAt: ago(30 * 60 * 1000),
            });
            expect((await service.runExpireScan({ quietWindowMs: 0 })).quietWindowMinutes).toBe(0);

            // 再建一单同样「不足 2 小时」的，用默认值扫 —— 必须仍被挡住，
            // 否则「覆盖」就变成了把 A 规则改松，而不是只影响那一次
            const another = await seedBooking({
                status: BookingStatus.EXPIRED,
                expiredAt: ago(30 * 60 * 1000),
                createdAt: ago(30 * 60 * 1000),
            });
            const normal = await service.runExpireScan();

            expect(normal.quietWindowMinutes).toBe(120);
            expect(await notifiedAtOf(another.bookingId)).toBeNull();
        });

        it('越界值在 service 层被钳制：负数归 0，超过 24 小时按 24 小时算', async () => {
            // DTO 已经拦过一道（400）；这条锁的是「绕过 HTTP 直接调 service」的第二道钳制
            expect((await service.runExpireScan({ quietWindowMs: -1 })).quietWindowMinutes).toBe(0);
            expect((await service.runExpireScan({ quietWindowMs: 30 * DAY })).quietWindowMinutes).toBe(24 * 60);
        });

        it('T2 ① 同样受覆盖影响', async () => {
            await seedBooking({
                status: BookingStatus.CONFIRMED,
                bookingDate: new Date(`${beijingDateStr()}T00:00:00`) as any,
                createdAt: ago(30 * 60 * 1000),
            });

            const normal = await service.runDailyReminderScan();
            expect(normal.remindedCount).toBe(0);
            expect(normal.quietWindowMinutes).toBe(120);

            const forced = await service.runDailyReminderScan({ quietWindowMs: 0 });
            expect(forced.remindedCount).toBe(1);
            expect(forced.quietWindowMinutes).toBe(0);
        });
    });
});
