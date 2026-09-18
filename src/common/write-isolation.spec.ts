import { Test } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import {
    Booking,
    BookingStatus,
    PaymentStatus,
    RefundStatus,
    TimeSlot,
    TravelMode,
} from '../entities/booking.entity';
import { BookingAnomaly } from '../entities/booking-anomaly.entity';
import { BookingRepository } from '../repositories/booking.repository';
import { serialTransaction, serialWrite } from './transaction-runner';

/**
 * 写入隔离实验：**裸 `update().execute()` 会不会被并发事务的回滚带走？**
 *
 * ── 为什么要单独验这条 ────────────────────────────────────────────────────
 * 2026-09-13 事故的修复按「每一处 `repo.save()` / `repo.remove()` 都是一次事务发起」
 * 这个口径排查，把这两类调用系统性换成了 `serialSave` / `serialRemove`。
 * 但 TypeORM 的 `createQueryBuilder().update().execute()` **不会**自开事务
 * （不走 EntityPersistExecutor），所以不在那次的范围内 —— 全仓仍有大量
 * 这样的写入（`markVerified` / `markExpired` / `markExpireNotified` / 支付状态更新…）。
 *
 * `transaction-runner.ts` 的注释说得很直接：
 *   「事务持锁期间，任何直接下发的写入都会被 sqlite 卷进那个未提交事务，
 *     随它一起提交或一起回滚，所以这类写入也要走同一把锁。」
 *
 * 本文件把这个说法变成一个可执行的判定。**判定结果：裸写确实会被吞。**
 * 2026-09-14 实测——事务自己的写被回滚（证明实验有效）的同时，
 * 同一窗口内发出的裸 `update().execute()` 也一起消失了，而它返回的 `affected=1`
 * 让调用方以为写成功了。
 *
 * 据此给全仓约 30 处裸写补了 `serialWrite`（`booking.repository` / `refund-apply` /
 * `message.repository` / `admin-application`）。所以本文件的用例现在锁的是**修复后的契约**：
 *   · 已排队的写入 —— 并发事务回滚时必须存活；
 *   · `serialWrite` 用在事务体内 —— 必须内联，不能排队（否则自己等自己）。
 * 任一条变红，都是有人把 `serialWrite` 去掉或改错了，不是用例本身的问题。
 *
 * ── 时序怎么造 ────────────────────────────────────────────────────────────
 * sqlite 全进程一条连接，事务在 `await` 点会让出事件循环，其它调用链的语句
 * 就在那个窗口里落到同一条连接上。所以事务体里先写一笔、**发出信号**、
 * 再 sleep 一段，外部收到信号后在这个窗口内发两笔写，最后让事务抛错回滚。
 */
describe('写入隔离：裸 execute() vs serialWrite', () => {
    let repo: BookingRepository;
    let raw: Repository<Booking>;
    let ds: DataSource;

    const mkBooking = (bookingId: string) => ({
        bookingId,
        wechatOpenId: 'openid-isolation-test',
        name: '隔离实验',
        phone: '13800000000',
        bookingDate: new Date('2026-09-13T00:00:00') as unknown as Date,
        timeSlot: TimeSlot.MORNING,
        travelMode: TravelMode.SELF_DRIVING,
        personCount: 1,
        remarks: '',
        status: BookingStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
        refundStatus: RefundStatus.NONE,
    });

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({
            imports: [
                TypeOrmModule.forRoot({
                    type: 'sqlite',
                    database: ':memory:',
                    synchronize: true,
                    dropSchema: true,
                    entities: [Booking, BookingAnomaly],
                }),
                TypeOrmModule.forFeature([Booking, BookingAnomaly]),
            ],
            providers: [BookingRepository],
        }).compile();

        repo = moduleRef.get(BookingRepository);
        raw = moduleRef.get(getRepositoryToken(Booking));
        ds = moduleRef.get(DataSource);
    });

    /**
     * 反向保险：`serialWrite` 用在事务体**内部**时，必须内联执行而不是排队。
     *
     * ── 为什么这条必须存在 ──────────────────────────────────────────────────
     * 给裸写补 `serialWrite` 的时候，最怕的不是没修好，而是**修出一个死锁**：
     * 如果事务体内部的写入被推到队列上，就成了「自己等自己」——
     * 事务 T 拿着锁等一个排在 T 后面的写，那个写永远轮不到，T 永远不结束。
     *
     * 这个陷阱本仓库踩过一次：`booking.service.ts` 里原本在事务体内用
     * `setImmediate` 触发常用联系人保存，它会在同一条连接上再开一次 BEGIN/COMMIT
     * 与父事务的 COMMIT 交错（2026-09-13 事故的触发点之一），后来改成
     * 「事务提交之后 + serialWrite」。所以这条契约必须被测试锁住，而不是靠注释。
     *
     * 契约来源：`transaction-runner.ts` 的 `serialWrite` ——
     * 「已在事务里时直接执行（并入外层事务，不再开事务是正确的，也不会碰 BEGIN/COMMIT）」。
     *
     * 死锁的表现是卡到 `WAIT_FAIL_MS`（30s）才报错，所以断言里同时卡一个时间上限，
     * 让失败信息直接指向"排队了"而不是靠超时才发现。
     */
    it('serialWrite 在事务体内调用时内联执行：不排队、不死锁、写入生效', async () => {
        const t0 = Date.now();

        await serialTransaction(ds, async (em) => {
            await em.save(em.create(Booking, mkBooking('ISO-INNER')));

            // 事务体内部调 serialWrite：必须内联（并入外层事务），不能去排队
            await serialWrite(ds, () =>
                raw
                    .createQueryBuilder()
                    .update(Booking)
                    .set({ remarks: 'inner' })
                    .where('bookingId = :id', { id: 'ISO-INNER' })
                    .execute(),
            );
        });

        const elapsed = Date.now() - t0;
        const row = await raw.findOne({ where: { bookingId: 'ISO-INNER' } });

        console.log(`[事务内 serialWrite] 耗时=${elapsed}ms（死锁会卡到 30000ms 才报错）`);
        console.log(`  写入生效=${row?.remarks === 'inner'}`);

        expect(row?.remarks).toBe('inner');
        // 死锁会走到 WAIT_FAIL_MS=30s 的超时才 reject，这里只要没接近那个量级就是内联了
        expect(elapsed).toBeLessThan(5000);
    });

    /**
     * 回归网：已排队的写入，在并发事务回滚时**必须存活**。
     *
     * 修复前（2026-09-14 实测）：这里调的是裸 `markVerified`，它返回 `affected=1`
     * 却被外层事务的回滚带走了 —— 扫码员看到「核销成功」，订单状态没变。
     *
     * 修复后 `markVerified` 已包进 `serialWrite`，所以这条用例现在锁的是
     * 「排队过的写入不再被别人的回滚吞掉」。**任何时候它变红，都说明有人把
     * `serialWrite` 去掉了**，而不是这条用例本身有问题。
     */
    it('并发事务回滚时：已排队的写入（markVerified）必须存活', async () => {
        await raw.save(raw.create(mkBooking('ISO-IN-TX')));
        await raw.save(raw.create(mkBooking('ISO-BARE')));
        await raw.save(raw.create(mkBooking('ISO-QUEUED')));

        let signalOpen!: () => void;
        const opened = new Promise<void>((r) => {
            signalOpen = r;
        });

        // 事务：写一笔 → 发信号 → 让出事件循环 → 抛错回滚
        const tx = serialTransaction(ds, async (em) => {
            await em.query(`UPDATE bookings SET remarks = 'A-in-tx' WHERE bookingId = 'ISO-IN-TX'`);
            signalOpen();
            await new Promise((r) => setTimeout(r, 200));
            throw new Error('boom: 故意让事务回滚');
        }).catch(() => 'rolled-back');

        await opened;

        // —— 窗口内：真实业务写入（markVerified），修复后它内部已走 serialWrite ——
        const bareAffected = await repo.markVerified('ISO-BARE', 'openid-verifier', Date.now());

        // —— 同一个窗口内：排队写 ——（不 await，让它去排队；事务结束后才会真正执行）
        const queued = serialWrite(ds, () =>
            raw
                .createQueryBuilder()
                .update(Booking)
                .set({ remarks: 'C-queued' })
                .where('bookingId = :id', { id: 'ISO-QUEUED' })
                .execute(),
        );

        await tx;
        await queued;

        const inTx = await raw.findOne({ where: { bookingId: 'ISO-IN-TX' } });
        const bare = await raw.findOne({ where: { bookingId: 'ISO-BARE' } });
        const queuedRow = await raw.findOne({ where: { bookingId: 'ISO-QUEUED' } });

        const inTxSurvived = inTx?.remarks === 'A-in-tx';
        const bareSurvived = bare?.status === BookingStatus.COMPLETED;
        const queuedSurvived = queuedRow?.remarks === 'C-queued';

        // 诊断输出：判定结果看这几行
        console.log('[写入隔离]');
        console.log(`  事务自己的写（ISO-IN-TX）        存活=${inTxSurvived}   期望=false`);
        console.log(`  markVerified 已排队（ISO-BARE）  存活=${bareSurvived}   期望=true`);
        console.log(`  serialWrite（ISO-QUEUED）        存活=${queuedSurvived}   期望=true`);
        console.log(`  markVerified 的 affected=${bareAffected}`);

        // 事务自己的写必须消失——否则说明这个实验根本没跑成回滚
        expect(inTxSurvived).toBe(false);
        // 排队写必须活下来——这是 serialWrite 的契约
        expect(queuedSurvived).toBe(true);
        // 核销写入必须活下来：修复前它返回 affected=1 却被回滚吞掉，是本次修复的核心场景
        expect(bareSurvived).toBe(true);
    });
});
