import { Logger } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';
import { DataSource, DeepPartial, EntityManager, ObjectLiteral, Repository } from 'typeorm';

/**
 * 事务串行器：同一 DataSource 上同时只允许一个事务在跑，其余排队。
 *
 * ── 为什么必须串行（2026-09-13 线上事故根因）─────────────────────────────
 * TypeORM 的 sqlite 驱动全进程只维护一条连接（SqliteDriver.createQueryRunner 永远返回
 * 同一个 SqliteQueryRunner），而 AbstractSqliteDriver.transactionSupport = "nested"，
 * 于是 startTransaction() 开头的 TransactionAlreadyStartedError 守卫**对 sqlite 不生效**，
 * 两个并发事务会一起冲进 SQL 层，共享的 transactionDepth 记账随之错位：
 *   · 并发的两个 BEGIN 都看到 depth=0 → 两条 BEGIN，第二条报
 *     SQLITE_ERROR: cannot start a transaction within a transaction；
 *   · 它失败清理时发出的裸 ROLLBACK，回滚掉的是**另一个请求**正在跑的事务；
 *   · depth 偏大后 commit/rollback 走 RELEASE / ROLLBACK TO SAVEPOINT 分支，
 *     而 ROLLBACK TO SAVEPOINT 既不结束事务也不复位 isTransactionActive ——
 *     留下一个**没有任何代码会去提交的开放事务**：进程内写入全部"成功"却只存在连接
 *     内存里、磁盘上没有，外部以写方式打开报 database is locked，重启即丢。
 * 单连接驱动不存在"并行事务"这回事，所以这里把它显式串行化：排队，而不是并发。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 * · 事务：`await serialTransaction(this.dataSource, async (em) => { ... })`
 *   替代 `this.dataSource.transaction(...)`，语义完全一致。
 * · 非事务写：`await serialWrite(this.dataSource, () => repo.save(...))`
 *   用于「绝不能被卷进别人事务」的写入。事务持锁期间，任何直接下发的写入都会被
 *   sqlite 卷进那个未提交事务，随它一起提交或一起回滚，所以这类写入也要走同一把锁。
 *   契约：在**自己所在**的事务体里调用会并入该事务（不排队、也不碰 BEGIN/COMMIT，这是
 *   正确语义）；要确保「绝不与别人的事务同生共死」，就不能在事务体里调用它 ——
 *   本模块自身不阻止这种调用，因为事务内写自己的数据本来就是常态。
 *
 * ── 两条硬约束 ──────────────────────────────────────────────────────────
 * 1. 禁止嵌套事务：已经在事务里再开一个会直接抛错。单连接下嵌套事务没有安全实现
 *    （SQLite 的 SAVEPOINT 记账正是上面被打坏的东西），需要复用外层事务时按既有约定
 *    把 EntityManager 显式传下去（见 BookingService.buildDailyFreeQuotaInfo 的 em 参数）。
 * 2. 必须由使用者显式排队：驱动不会替你拦，绕开本模块直接调 dataSource.transaction
 *    等于把事故的触发条件重新装回去。
 */

/** 等待锁超过该时长就告警：说明前一个事务迟迟不结束 */
const WAIT_WARN_MS = 5000;
/** 事务体持续超过该时长就报错：这正是事故状态（事务永不结束），必须留下明确日志 */
const BODY_ERROR_MS = 30000;
/** 等待锁超过该时长直接失败：宁可让调用方报错，也不无限堆积请求 */
const WAIT_FAIL_MS = 30000;

const logger = new Logger('TransactionRunner');

/** 每个 DataSource 一条 FIFO 队列；不同库文件（prod.db / logs.db）互不阻塞 */
const queues = new WeakMap<DataSource, Promise<unknown>>();
/** 当前排队 + 执行中的数量，仅用于日志与告警文案 */
const pending = new WeakMap<DataSource, number>();
/**
 * 当前异步调用链是否已在该 DataSource 的事务里（重入判定）。
 * 注意：AsyncLocalStorage 会传播进 setImmediate / setTimeout / 未 await 的续体，
 * 所以事务结束时必须把标记撤销（见 runInContext 的 finally），
 * 否则"事务里派生的延迟回调"会自称仍在事务中而绕开排队。
 */
const context = new AsyncLocalStorage<Set<DataSource>>();

/**
 * 串行执行一个事务（替代 `dataSource.transaction`）
 * @throws 若当前调用链已经在同一 DataSource 的事务里
 */
export function serialTransaction<T>(
    dataSource: DataSource,
    work: (entityManager: EntityManager) => Promise<T>,
): Promise<T> {
    if (context.getStore()?.has(dataSource)) {
        throw new Error(
            '禁止嵌套事务：当前调用链已在同一 sqlite DataSource 的事务里（单连接驱动下嵌套事务会把 ' +
                'BEGIN/COMMIT 记账打坏，见 src/common/transaction-runner.ts）。' +
                '需要复用外层事务时，请把 EntityManager 显式传给被调方法。',
        );
    }
    return runExclusive(dataSource, '事务', () => dataSource.transaction(work));
}

/**
 * 串行执行一次非事务写入：只借同一把锁，保证不会与正在跑的事务交错在同一条连接上。
 * 已在事务里时直接执行（并入外层事务，不再开事务是正确的，也不会碰 BEGIN/COMMIT）。
 */
export function serialWrite<T>(dataSource: DataSource, work: () => Promise<T>): Promise<T> {
    if (context.getStore()?.has(dataSource)) return work();
    return runExclusive(dataSource, '写入', work);
}

/**
 * 串行执行一次 `repository.save()`。
 *
 * 为什么 save 也要排队：EntityPersistExecutor 在 `!queryRunner.isTransactionActive` 时会
 * **自己开一个事务**（BEGIN → 写 → COMMIT）。也就是说全仓每一处 repo.save() 都是一次事务发起，
 * 绕过本模块就会把「并发事务」重新装回来：既可能撞坏 BEGIN/COMMIT 记账，
 * 也可能让这笔写入被卷进别人的事务、随别人的回滚一起消失
 * （例如支付回调的订单状态更新被一个失败的下单事务带走 → 用户付了钱、订单还是未支付）。
 * 在事务体里调用时并入外层事务（见 serialWrite 契约），因此可以安全地逐处套用。
 */
export function serialSave<Entity extends ObjectLiteral, T extends DeepPartial<Entity>>(
    repository: Repository<Entity>,
    entity: T,
): Promise<T & Entity>;
export function serialSave<Entity extends ObjectLiteral, T extends DeepPartial<Entity>>(
    repository: Repository<Entity>,
    entities: T[],
): Promise<(T & Entity)[]>;
export function serialSave<Entity extends ObjectLiteral, T extends DeepPartial<Entity>>(
    repository: Repository<Entity>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    entity: T | T[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
    // 重载在上方收敛：调用方各自拿到精确类型，实现体只负责转发
    return serialWrite(repository.manager.connection, () => repository.save(entity as never));
}

/**
 * 串行执行一次 `repository.remove()`。同 serialSave：remove 内部也会自己开事务。
 */
export function serialRemove<Entity extends ObjectLiteral, T extends DeepPartial<Entity>>(
    repository: Repository<Entity>,
    entity: T,
): Promise<T & Entity>;
export function serialRemove<Entity extends ObjectLiteral, T extends DeepPartial<Entity>>(
    repository: Repository<Entity>,
    entities: T[],
): Promise<(T & Entity)[]>;
export function serialRemove<Entity extends ObjectLiteral, T extends DeepPartial<Entity>>(
    repository: Repository<Entity>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    entity: T | T[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
    return serialWrite(repository.manager.connection, () => repository.remove(entity as never));
}

/**
 * 排队拿到锁后再执行（FIFO）。失败不会中断队列。
 */
function runExclusive<T>(dataSource: DataSource, kind: string, work: () => Promise<T>): Promise<T> {
    const queuedAt = Date.now();
    pending.set(dataSource, (pending.get(dataSource) ?? 0) + 1);

    const previous = queues.get(dataSource) ?? Promise.resolve();
    let abandoned = false;
    let acquireTimer: NodeJS.Timeout | null = null;

    const task = previous.then(async () => {
        // 已因超时放弃：绝不能再动手，否则会撞上此刻的持锁者
        if (abandoned) return undefined as T;
        if (acquireTimer) {
            clearTimeout(acquireTimer);
            acquireTimer = null;
        }
        pending.set(dataSource, Math.max(0, (pending.get(dataSource) ?? 1) - 1));
        const waited = Date.now() - queuedAt;
        const behind = pending.get(dataSource) ?? 0;
        if (waited >= WAIT_WARN_MS) {
            logger.warn(`等待 sqlite ${kind}锁 ${waited}ms（其后还有 ${behind} 个排队）—— 前一个事务可能卡住了`);
        }
        return runInContext(dataSource, kind, work);
    });

    // 队列接力：吞掉 reject，保证一次失败不会卡死整条队列
    queues.set(
        dataSource,
        task.then(
            () => undefined,
            () => undefined,
        ),
    );

    const timeout = new Promise<never>((_, reject) => {
        acquireTimer = setTimeout(() => {
            abandoned = true;
            pending.set(dataSource, Math.max(0, (pending.get(dataSource) ?? 1) - 1));
            reject(
                new Error(
                    `等待 sqlite ${kind}锁超过 ${WAIT_FAIL_MS}ms：进程内已有事务长时间不结束。` +
                        `此时该事务的写入只存在于内存中，唯一的恢复手段是重启进程 —— ` +
                        `重启前请先存档 data/ 下的 *.db-journal 并导出应用侧数据（见 src/common/transaction-runner.ts）`,
                ),
            );
        }, WAIT_FAIL_MS);
        // 不因这个定时器拖住进程退出
        acquireTimer.unref?.();
    });

    return Promise.race([task, timeout]);
}

/**
 * 建立事务上下文后执行，并挂事务体看门狗。
 */
function runInContext<T>(dataSource: DataSource, kind: string, work: () => Promise<T>): Promise<T> {
    const scope = new Set(context.getStore() ?? []);
    scope.add(dataSource);

    let bodyTimer: NodeJS.Timeout | null = null;
    const body = context.run(scope, () => {
        bodyTimer = setTimeout(() => {
            logger.error(
                `sqlite ${kind}已持续 ${BODY_ERROR_MS}ms 仍未结束：连接上可能有一个永远不会提交的开放事务，` +
                    `此后进程内所有写入都只会留在内存里、磁盘上没有（线上事故状态）。` +
                    `请存档 data/ 下的 *.db-journal 并重启进程，再凭本行日志定位是哪个 ${kind}卡住。`,
            );
        }, BODY_ERROR_MS);
        bodyTimer.unref?.();
        return work();
    });

    return Promise.resolve(body).finally(() => {
        if (bodyTimer) clearTimeout(bodyTimer);
        // 撤销重入标记：事务结束后，由它派生的 setImmediate/setTimeout 不能再自称"在事务里"
        scope.delete(dataSource);
    });
}
