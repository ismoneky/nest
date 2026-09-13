import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, EntitySchema } from 'typeorm';
import { serialTransaction, serialWrite } from './transaction-runner';

/**
 * 只用于验证事务机制的探针表：刻意不依赖任何业务实体。
 * （本文件测的是「单连接 sqlite 上的事务记账」，与业务语义无关）
 */
const Probe = new EntitySchema({
    name: 'RunnerProbe',
    tableName: 'runner_probe',
    columns: {
        id: { type: Number, primary: true, generated: true },
        v: { type: String, nullable: true },
    },
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 事务串行器回归测试（2026-09-13 线上事故）
 *
 * 锁住的是事故根因：sqlite 驱动全进程共用一条连接、且 transactionSupport="nested"
 * 使并发事务冲进 SQL 层互相破坏（BEGIN 碰撞 → 裸 ROLLBACK 回滚掉对方的事务 →
 * 事务记账错位 → 留下永远不会提交的开放事务）。
 * 修复前跑本文件：并发用例会报 cannot start a transaction within a transaction
 * 或 Transaction is not started yet，且写入会被卷进别人的事务。
 */
describe('transaction-runner', () => {
    let dataSource: DataSource;

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({
            imports: [
                TypeOrmModule.forRoot({
                    type: 'sqlite',
                    database: ':memory:',
                    synchronize: true,
                    dropSchema: true,
                    entities: [Probe],
                }),
            ],
        }).compile();

        dataSource = moduleRef.get(DataSource);
    });

    beforeEach(async () => {
        await dataSource.query('DELETE FROM runner_probe');
    });

    const values = async (): Promise<string[]> => {
        const rows: { v: string }[] = await dataSource.query('SELECT v FROM runner_probe ORDER BY id');
        return rows.map((r) => r.v);
    };

    it('并发事务都成功提交，数据全部落盘（修复前必有一方报错或数据丢失）', async () => {
        const results = await Promise.allSettled([
            serialTransaction(dataSource, async (em) => {
                await em.query("INSERT INTO runner_probe (v) VALUES ('A')");
                await sleep(30);
                return 'A';
            }),
            serialTransaction(dataSource, async (em) => {
                await em.query("INSERT INTO runner_probe (v) VALUES ('B')");
                await sleep(30);
                return 'B';
            }),
        ]);

        expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
        expect(await values()).toEqual(['A', 'B']);
    });

    it('事务互不重叠（FIFO）：同一时刻只有一个事务体在执行，且按入队顺序执行', async () => {
        let active = 0;
        let maxActive = 0;
        const task = (tag: string) =>
            serialTransaction(dataSource, async (em) => {
                active += 1;
                maxActive = Math.max(maxActive, active);
                await sleep(20);
                await em.query(`INSERT INTO runner_probe (v) VALUES ('${tag}')`);
                active -= 1;
            });

        await Promise.all([task('t1'), task('t2'), task('t3')]);

        expect(maxActive).toBe(1);
        expect(await values()).toEqual(['t1', 't2', 't3']);
    });

    it('事务持锁期间，来自其它调用链的写入必须排队，不会被卷进该事务', async () => {
        let txEntered!: () => void;
        const entered = new Promise<void>((resolve) => {
            txEntered = resolve;
        });
        let writeDone = false;
        let seenInsideTransaction: string[] = [];

        const tx = serialTransaction(dataSource, async (em) => {
            await em.query("INSERT INTO runner_probe (v) VALUES ('in-tx')");
            txEntered();
            await sleep(50);
            // 事务内自查：外部那笔写入此时必须还没执行。
            // 若它被卷进本事务，这里就会看到 2 行 —— 且它会随本事务一起提交/回滚（事故现象）
            seenInsideTransaction = await values();
            expect(writeDone).toBe(false);
        });

        await entered; // 事务已持锁
        void serialWrite(dataSource, async () => {
            await dataSource.query("INSERT INTO runner_probe (v) VALUES ('outside')");
            writeDone = true;
        });

        await tx;
        expect(seenInsideTransaction).toEqual(['in-tx']);
        await sleep(20);
        expect(writeDone).toBe(true);
        expect(await values()).toEqual(['in-tx', 'outside']);
    });

    it('事务内派生的延迟回调在事务结束后会正常排队（重入标记随事务结束撤销）', async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let delayedDone = false;

        // 事务 A：在事务体内调度一个延迟写入，它捕获了「在事务里」的上下文快照
        await serialTransaction(dataSource, async () => {
            setImmediate(() => {
                void gate.then(async () => {
                    await serialWrite(dataSource, async () => {
                        await dataSource.query("INSERT INTO runner_probe (v) VALUES ('delayed')");
                    });
                    delayedDone = true;
                });
            });
        });

        // 事务 B：慢事务，持锁 40ms
        const txB = serialTransaction(dataSource, async () => {
            await sleep(40);
        });
        release(); // 此刻事务 B 正持锁

        await sleep(10);
        // 标记若未随事务结束撤销，这笔写入会直接插进 B 的事务里 —— 同一连接，这里就能查到
        expect(delayedDone).toBe(false);
        expect(await values()).toEqual([]);

        await txB;
        await sleep(20);
        expect(delayedDone).toBe(true);
        expect(await values()).toEqual(['delayed']);
    });

    it('禁止嵌套事务：事务内再开事务直接抛错', async () => {
        await expect(
            serialTransaction(dataSource, async (em) => {
                await em.query("INSERT INTO runner_probe (v) VALUES ('outer')");
                await serialTransaction(dataSource, async () => undefined);
            }),
        ).rejects.toThrow(/禁止嵌套事务/);
        // 外层事务已回滚，不留半截数据
        expect(await values()).toEqual([]);
    });

    it('读不走队列：事务持锁期间读请求照常返回（页面轮询不被写突发堵住）', async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let entered!: () => void;
        const txEntered = new Promise<void>((resolve) => {
            entered = resolve;
        });

        const tx = serialTransaction(dataSource, async (em) => {
            await em.query("INSERT INTO runner_probe (v) VALUES ('holding')");
            entered();
            await gate;
        });

        await txEntered;
        // 事务仍持锁时读一次：读是单条语句，不该排队等整个事务结束
        const readStartedAt = Date.now();
        await dataSource.query('SELECT count(*) AS c FROM runner_probe');
        expect(Date.now() - readStartedAt).toBeLessThan(200);

        release();
        await tx;
    });

    it('一次事务失败不会卡死队列：后续事务照常执行', async () => {
        await expect(
            serialTransaction(dataSource, async () => {
                throw new Error('boom');
            }),
        ).rejects.toThrow('boom');

        await serialTransaction(dataSource, async (em) => {
            await em.query("INSERT INTO runner_probe (v) VALUES ('after-boom')");
        });

        expect(await values()).toEqual(['after-boom']);
    });
});
