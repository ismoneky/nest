import { Test } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import {
    Booking,
    BookingStatus,
    PaymentStatus,
    RefundStatus,
    RefundSource,
    RefundSubmitStatus,
    TimeSlot,
    TravelMode,
} from '../../entities/booking.entity';
import { BookingAnomaly } from '../../entities/booking-anomaly.entity';
import { BatchRefundTask, BatchRefundTaskStatus } from '../../entities/batch-refund-task.entity';
import { BookingRepository } from '../../repositories/booking.repository';
import { BatchRefundTaskRepository } from '../../repositories/batch-refund-task.repository';
import { BatchRefundService } from './batch-refund.service';
import { WechatPayService } from '../wechat-pay/wechat-pay.service';
import { LoggingService } from '../logging/logging.service';

/**
 * 选择性批量退款核心流程测试（设计 2.4 / 2.6 / 2.7 / 2.8）
 * 夹具均为虚构数据，不含真实用户信息。
 */
describe('BatchRefundService', () => {
    let service: BatchRefundService;
    let bookingRepo: BookingRepository;
    let taskRepo: BatchRefundTaskRepository;
    let bookingTypeRepo: Repository<Booking>;
    let taskTypeRepo: Repository<BatchRefundTask>;
    let dataSource: DataSource;
    let refundMock: jest.Mock;

    beforeAll(async () => {
        refundMock = jest.fn();

        const moduleRef = await Test.createTestingModule({
            imports: [
                TypeOrmModule.forRoot({
                    type: 'sqlite',
                    database: ':memory:',
                    synchronize: true,
                    dropSchema: true,
                    entities: [Booking, BookingAnomaly, BatchRefundTask],
                }),
                TypeOrmModule.forFeature([Booking, BookingAnomaly, BatchRefundTask]),
            ],
            providers: [
                BatchRefundService,
                BookingRepository,
                BatchRefundTaskRepository,
                { provide: WechatPayService, useValue: { refund: refundMock, batchRefundRecalc: null } },
                { provide: LoggingService, useValue: { write: jest.fn() } },
            ],
        })
            .useMocker((token) => {
                if (token === DataSource) {
                    return undefined; // 由 forRoot 提供，不需要额外 mock
                }
                return undefined;
            })
            .compile();

        service = moduleRef.get(BatchRefundService);
        bookingRepo = moduleRef.get(BookingRepository);
        taskRepo = moduleRef.get(BatchRefundTaskRepository);
        bookingTypeRepo = moduleRef.get(getRepositoryToken(Booking));
        taskTypeRepo = moduleRef.get(getRepositoryToken(BatchRefundTask));
        dataSource = moduleRef.get<DataSource>(DataSource);

        await seedFixtures(bookingTypeRepo);
    });

    afterAll(async () => {
        // sqlite :memory: 连接随进程退出回收
    });

    /**
     * 夹具（按 ID 列表选择，与预约日期无关）：
     * - TLB0001TEST 可退（confirmed/paid/none/5000 分/2 人）
     * - TLB0002TEST 可退（refundStatus failed，验证 FAILED 可重进，3000 分/2 人）
     * - TLB0003TEST 可退（completed 已核验，管理员版可退，1000 分/2 人）
     * - TLB0004TEST 免费 → 排除
     * - TLB0005TEST 退款中 → 排除
     * - TLB0006TEST 可退（预约日期 2026-08-19，证明选择跨日期，4000 分/1 人）
     * - TLPEND001TEST 可退（专供 P0-1 冻结回归测试，不被其他用例勾选）
     */
    async function seedFixtures(repo: Repository<Booking>) {
        const now = Date.now();
        const base = {
            wechatOpenId: 'o-TEST',
            bookingDate: '2026-08-18',
            timeSlot: TimeSlot.MORNING,
            travelMode: TravelMode.SELF_DRIVING,
            personCount: 2,
            status: BookingStatus.CONFIRMED,
            paymentStatus: PaymentStatus.PAID,
            refundStatus: RefundStatus.NONE,
            isFree: false,
            paidAt: new Date(now - 24 * 60 * 60 * 1000),
            createdAt: new Date(now - 48 * 60 * 60 * 1000),
            updatedAt: new Date(now - 48 * 60 * 60 * 1000),
        };
        await repo.save([
            { ...base, bookingId: 'TLB0001TEST', amount: 5000, outTradeNo: 'OT-001', name: '张三', phone: '13800000001' },
            { ...base, bookingId: 'TLB0002TEST', amount: 3000, outTradeNo: 'OT-002', refundStatus: RefundStatus.FAILED, name: '李四', phone: '13800000002' },
            { ...base, bookingId: 'TLB0003TEST', amount: 1000, outTradeNo: 'OT-003', status: BookingStatus.COMPLETED, name: '王五' },
            { ...base, bookingId: 'TLB0004TEST', amount: 0, outTradeNo: 'OT-004', isFree: true, name: '赵六' },
            { ...base, bookingId: 'TLB0005TEST', amount: 2000, outTradeNo: 'OT-005', refundStatus: RefundStatus.REFUNDING, name: '钱七' },
            { ...base, bookingId: 'TLB0006TEST', bookingDate: '2026-08-19', amount: 4000, outTradeNo: 'OT-006', personCount: 1, name: '孙八', phone: '13800000006' },
            { ...base, bookingId: 'TLPEND001TEST', amount: 1000, outTradeNo: 'OT-P01', name: '测试' },
        ] as any[]);
    }

    const SIX_IDS = ['TLB0001TEST', 'TLB0002TEST', 'TLB0003TEST', 'TLB0004TEST', 'TLB0005TEST', 'TLB0006TEST'];

    describe('preview（按 ID 列表）', () => {
        it('可退聚合与不可退分桶：已核验可退、跨日期、分桶附订单号', async () => {
            const result = await service.preview(SIX_IDS);
            // B1/B2/B3(completed)/B6 可退：管理员版不看业务状态
            expect(result.refundable.count).toBe(4);
            expect(result.refundable.totalAmount).toBe(13000);
            expect(result.refundable.peopleCount).toBe(7);
            const buckets = Object.fromEntries(result.unrefundable.map((u: any) => [u.reason, u]));
            expect(buckets.free.count).toBe(1);
            expect(buckets.free.bookingIds).toEqual(['TLB0004TEST']);
            expect(buckets.refunding.count).toBe(1);
            expect(buckets.refunding.bookingIds).toEqual(['TLB0005TEST']);
            expect(buckets.completed).toBeUndefined(); // 管理员版无已完成分桶
            // 明细掩码
            expect(result.detailPreview[0].phone).toMatch(/^138\*{4}\d{4}$/);
            expect(result.detailPreview).toHaveLength(4);
        });

        it('只勾选不可退订单：可退聚合为 0', async () => {
            const result = await service.preview(['TLB0004TEST', 'TLB0005TEST']);
            expect(result.refundable.count).toBe(0);
            expect(result.detailPreview).toHaveLength(0);
        });

        it('无 RUNNING 任务时 runningTask 为 null', async () => {
            const result = await service.preview(SIX_IDS);
            expect(result.runningTask).toBeNull();
        });
    });

    describe('execute（事务冻结）', () => {
        it('冻结勾选的可退订单并返回 totalTarget（含已核验、跨日期）', async () => {
            refundMock.mockResolvedValue({ state: 'accepted' });
            const result = await service.execute(SIX_IDS, '景区临时关闭退款', 'tester');

            expect(result.totalTarget).toBe(4);
            expect(result.status).toBe(BatchRefundTaskStatus.RUNNING);

            // 等待 worker 完成（内存任务，4 单 × 300ms 间隔）
            await waitFor(async () => (await taskRepo.findByTaskId(result.taskId)).status !== BatchRefundTaskStatus.RUNNING, 15000);

            const b1 = await bookingTypeRepo.findOne({ where: { bookingId: 'TLB0001TEST' } });
            expect(b1.refundStatus).toBe(RefundStatus.REFUNDING);
            expect(b1.refundSource).toBe(RefundSource.BATCH);
            expect(b1.refundBatchTaskId).toBe(result.taskId);
            expect(b1.refundSubmitStatus).toBe(RefundSubmitStatus.SUBMITTED);
            expect(b1.outRefundNo).toBe('RFTLB0001TEST');

            // 已核验订单也被冻结提交（管理员版规则）
            const b3 = await bookingTypeRepo.findOne({ where: { bookingId: 'TLB0003TEST' } });
            expect(b3.refundSubmitStatus).toBe(RefundSubmitStatus.SUBMITTED);
            // 免费单/退款中订单不被冻结
            const b4 = await bookingTypeRepo.findOne({ where: { bookingId: 'TLB0004TEST' } });
            expect(b4.refundStatus).toBe(RefundStatus.NONE);
            expect(b4.refundBatchTaskId).toBeNull();

            // 选择摘要：实际冻结订单的去重预约日期
            const task = await taskRepo.findByTaskId(result.taskId);
            expect(task.selectionSummary.split(',').sort()).toEqual(['2026-08-18', '2026-08-19']);

            // 进度聚合互斥
            const detail = await service.getTask(result.taskId);
            expect(detail.progress.total).toBe(4);
            expect(detail.progress.pending).toBe(0);
            expect(detail.progress.confirmed).toBe(0);
            expect(detail.progress.processing).toBe(4);
            // 任务推进到 SUBMISSION_COMPLETED（微信已受理，等待回调/对账）
            expect(detail.status).toBe(BatchRefundTaskStatus.SUBMISSION_COMPLETED);
        });

        it('上一任务提交完毕后再次执行同一批订单：不被 409 阻塞，但订单已冻结 → 400 无可退订单', async () => {
            // 上一任务已 SUBMISSION_COMPLETED，不阻塞新任务（只阻塞 RUNNING）；
            // 但可退订单已全部 REFUNDING，不再满足资金条件 → affected=0 → 400
            await expect(service.execute(SIX_IDS, '第二次执行残余', 'tester'))
                .rejects.toThrow(BadRequestException);
        });

        it('已有 RUNNING 任务时 execute 返回 409 并携带当前 taskId', async () => {
            const running = await taskTypeRepo.save(taskTypeRepo.create({
                taskId: 'BRTTEST40901',
                selectionSummary: '2026-08-18',
                status: BatchRefundTaskStatus.RUNNING,
                reason: '占位', operatorAdminId: 't', totalTarget: 1,
            }));
            const err = await service.execute(['TLPEND001TEST'], '并发执行', 'tester').catch((e) => e);
            expect(err).toBeInstanceOf(ConflictException);
            expect(err.response.taskId).toBe('BRTTEST40901');
            // 收尾：置为 COMPLETED，避免影响后续用例
            running.status = BatchRefundTaskStatus.COMPLETED;
            await taskTypeRepo.save(running);
        });
    });

    describe('P0-1 回归：冻结的 PENDING 订单不进入退款对账', () => {
        it('冻结不写调度字段，对账候选排除 PENDING', async () => {
            // 直接调冻结（不启动 worker），观察冻结后的调度字段
            await dataSource.transaction(async (em) => {
                const affected = await bookingRepo.freezeBookingsForBatchRefund(em, ['TLPEND001TEST'], 'BRTTESTPEND01', Date.now());
                expect(affected).toBe(1);
            });

            const b = await bookingTypeRepo.findOne({ where: { bookingId: 'TLPEND001TEST' } });
            expect(b.refundStatus).toBe(RefundStatus.REFUNDING);
            expect(b.refundSubmitStatus).toBe(RefundSubmitStatus.PENDING);
            // 关键断言：未提交订单不得排对账（否则对账查 NOT_EXIST 会误判 FAILED）
            expect(b.reconcileKind).toBeNull();
            expect(b.reconcileNextAt).toBeNull();

            // 双保险：即使调度字段被意外污染，对账候选也不得领取 PENDING 订单
            const farFuture = Date.now() + 60 * 60 * 1000;
            const candidates = await bookingRepo.findReconcileCandidates('refund', farFuture, 50);
            expect(candidates.find((c) => c.bookingId === 'TLPEND001TEST')).toBeUndefined();
        });
    });

    describe('进度聚合互斥（pending + processing + confirmed + failed = total）', () => {
        it('各类状态计数互斥', async () => {
            // 手工构造一个任务，覆盖四类状态（repository.create() 建实体实例，@BeforeInsert 才会补 createdAt）
            const task = await taskTypeRepo.save(taskTypeRepo.create({
                taskId: 'BRTTESTAGG01',
                selectionSummary: '2026-08-18',
                status: BatchRefundTaskStatus.SUBMISSION_COMPLETED,
                reason: '测试聚合',
                operatorAdminId: 'tester',
                totalTarget: 4,
            }));

            const now = Date.now();
            await bookingTypeRepo.save(withTimestamps([
                {
                    bookingId: 'TLAGG0001TEST', wechatOpenId: 'o-A', bookingDate: '2026-08-18', timeSlot: TimeSlot.AFTERNOON,
                    travelMode: TravelMode.SCENIC_BUS, personCount: 1, status: BookingStatus.CONFIRMED,
                    paymentStatus: PaymentStatus.PAID, refundStatus: RefundStatus.REFUNDING, isFree: false,
                    amount: 1000, outTradeNo: 'OT-A', paidAt: new Date(now - 1000),
                    refundSource: RefundSource.BATCH, refundBatchTaskId: task.taskId, refundSubmitStatus: RefundSubmitStatus.PENDING,
                },
                {
                    bookingId: 'TLAGG0002TEST', wechatOpenId: 'o-B', bookingDate: '2026-08-18', timeSlot: TimeSlot.AFTERNOON,
                    travelMode: TravelMode.SCENIC_BUS, personCount: 1, status: BookingStatus.CONFIRMED,
                    paymentStatus: PaymentStatus.PAID, refundStatus: RefundStatus.REFUNDING, isFree: false,
                    amount: 2000, outTradeNo: 'OT-B', paidAt: new Date(now - 1000),
                    refundSource: RefundSource.BATCH, refundBatchTaskId: task.taskId, refundSubmitStatus: RefundSubmitStatus.SUBMITTED,
                },
                {
                    bookingId: 'TLAGG0003TEST', wechatOpenId: 'o-C', bookingDate: '2026-08-18', timeSlot: TimeSlot.AFTERNOON,
                    travelMode: TravelMode.SCENIC_BUS, personCount: 1, status: BookingStatus.REFUNDED,
                    paymentStatus: PaymentStatus.REFUNDED, refundStatus: RefundStatus.REFUNDED, isFree: false,
                    amount: 3000, outTradeNo: 'OT-C', paidAt: new Date(now - 1000),
                    refundSource: RefundSource.BATCH, refundBatchTaskId: task.taskId, refundSubmitStatus: RefundSubmitStatus.SUBMITTED,
                },
                {
                    bookingId: 'TLAGG0004TEST', wechatOpenId: 'o-D', bookingDate: '2026-08-18', timeSlot: TimeSlot.AFTERNOON,
                    travelMode: TravelMode.SCENIC_BUS, personCount: 1, status: BookingStatus.CONFIRMED,
                    paymentStatus: PaymentStatus.PAID, refundStatus: RefundStatus.FAILED, isFree: false,
                    amount: 4000, outTradeNo: 'OT-D', paidAt: new Date(now - 1000),
                    refundSource: RefundSource.BATCH, refundBatchTaskId: task.taskId, refundSubmitStatus: RefundSubmitStatus.FAILED,
                },
            ]) as any[]);

            const progress = await bookingRepo.aggregateBatchRefundProgress(task.taskId);
            expect(progress.total).toBe(4);
            expect(progress.pending).toBe(1);
            expect(progress.processing).toBe(1);
            expect(progress.confirmed).toBe(1);
            expect(progress.failed).toBe(1);
            expect(progress.confirmedAmount).toBe(3000);
            expect(progress.pending + progress.processing + progress.confirmed + progress.failed).toBe(progress.total);
        });
    });

    describe('recalcTaskStatus 推进规则', () => {
        it('全部 REFUNDED → COMPLETED', async () => {
            const task = await taskTypeRepo.save(taskTypeRepo.create({
                taskId: 'BRTTESTREC01', selectionSummary: '2026-08-18',
                status: BatchRefundTaskStatus.SUBMISSION_COMPLETED,
                reason: '测试推进', operatorAdminId: 't', totalTarget: 1,
            }));
            const now = Date.now();
            await bookingTypeRepo.save(withTimestamps([{
                bookingId: 'TLREC0001TEST', wechatOpenId: 'o-R', bookingDate: '2026-08-18', timeSlot: TimeSlot.AFTERNOON,
                travelMode: TravelMode.SCENIC_BUS, personCount: 1, status: BookingStatus.REFUNDED,
                paymentStatus: PaymentStatus.REFUNDED, refundStatus: RefundStatus.REFUNDED, isFree: false,
                amount: 1000, outTradeNo: 'OT-R', paidAt: new Date(now - 1000),
                refundSource: RefundSource.BATCH, refundBatchTaskId: task.taskId, refundSubmitStatus: RefundSubmitStatus.SUBMITTED,
            }]) as any);

            const next = await service.recalcTaskStatus(task);
            expect(next).toBe(BatchRefundTaskStatus.COMPLETED);
            const fresh = await taskRepo.findByTaskId(task.taskId);
            expect(fresh.completedAt).toBeDefined();
        });

        it('终态含 FAILED → COMPLETED_WITH_FAILURES', async () => {
            const task = await taskTypeRepo.save(taskTypeRepo.create({
                taskId: 'BRTTESTREC02', selectionSummary: '2026-08-18',
                status: BatchRefundTaskStatus.SUBMISSION_COMPLETED,
                reason: '测试推进', operatorAdminId: 't', totalTarget: 2,
            }));
            const now = Date.now();
            await bookingTypeRepo.save(withTimestamps([
                {
                    bookingId: 'TLREC0002TEST', wechatOpenId: 'o-R2', bookingDate: '2026-08-18', timeSlot: TimeSlot.AFTERNOON,
                    travelMode: TravelMode.SCENIC_BUS, personCount: 1, status: BookingStatus.REFUNDED,
                    paymentStatus: PaymentStatus.REFUNDED, refundStatus: RefundStatus.REFUNDED, isFree: false,
                    amount: 1000, outTradeNo: 'OT-R2', paidAt: new Date(now - 1000),
                    refundSource: RefundSource.BATCH, refundBatchTaskId: task.taskId, refundSubmitStatus: RefundSubmitStatus.SUBMITTED,
                },
                {
                    bookingId: 'TLREC0003TEST', wechatOpenId: 'o-R3', bookingDate: '2026-08-18', timeSlot: TimeSlot.AFTERNOON,
                    travelMode: TravelMode.SCENIC_BUS, personCount: 1, status: BookingStatus.CONFIRMED,
                    paymentStatus: PaymentStatus.PAID, refundStatus: RefundStatus.FAILED, isFree: false,
                    amount: 1000, outTradeNo: 'OT-R3', paidAt: new Date(now - 1000),
                    refundSource: RefundSource.BATCH, refundBatchTaskId: task.taskId, refundSubmitStatus: RefundSubmitStatus.FAILED,
                },
            ]) as any);

            const next = await service.recalcTaskStatus(task);
            expect(next).toBe(BatchRefundTaskStatus.COMPLETED_WITH_FAILURES);
        });
    });
});

/** 轮询等待条件成立（worker 异步完成） */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number, intervalMs = 200): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error('waitFor 超时');
}

/** 补齐 createdAt/updatedAt（entity listener 在 save(plain object) 时不触发） */
function withTimestamps<T extends object>(rows: T[]): (T & { createdAt: Date; updatedAt: Date })[] {
    const now = new Date();
    return rows.map((r) => ({ createdAt: now, updatedAt: now, ...r })) as any;
}
