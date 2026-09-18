import { LoggingService } from './logging.service';
import { AppLog, AppLogLevel, AppLogSource, AppLogCategory } from '../../entities/app-log.entity';

/**
 * 日志级别闸门（`APP_LOG_MIN_LEVEL`，默认 WARN）
 *
 * ── 为什么这个文件必须存在 ────────────────────────────────────────────────
 * 这是一段**会静默丢数据**的代码：低于阈值的日志不报错、不告警、不留痕，
 * 就是没了。写错了没有任何反馈——要么日志莫名变少（阈值配太高），
 * 要么白写一堆（阈值没生效）。所以每条规则都要钉住。
 *
 * 锁定的四件事：
 *   1. **在入队前就丢**。放进队列再等刷盘过滤等于白占队列名额和写事务，
 *      而那正是本次改动要消除的开销；
 *   2. **stdout 路径同样过滤**。日志走 stdout 时（`APP_LOG_SQLITE_ENABLED=false`）
 *      不该出现「关掉落库后 INFO 又回来了」这种自相矛盾的行为；
 *   3. **`persistClientBatch` 必须把被丢的那些也回执为 accepted** ⚠️
 *      这是本文件最重要的一条。小程序是按 acceptedLogIds 判断上报成败的，
 *      漏掉谁就会一直重传谁——本地上报队列被这批永远传不上去的 INFO 堵死，
 *      真正该上来的 ERROR 反而挤不出去。**丢日志不能变成堵日志**；
 *   4. **配置写错回落 WARN**，不能变成「一个拼错的字符串把日志全关了」。
 *
 * 夹具为虚构数据。
 */

const makeEntry = (level: AppLogLevel, message = '消息') => ({
    source: AppLogSource.BACKEND,
    level,
    category: AppLogCategory.BOOKING,
    message,
});

/** 造一个能观察 insertBatch 实际收到哪些行的替身仓储 */
function makeRepo() {
    const batches: AppLog[][] = [];
    const builder = {
        insert: () => builder,
        values: (rows: AppLog[]) => {
            batches.push(rows);
            return builder;
        },
        orIgnore: () => builder,
        execute: async () => undefined,
    };
    return { repo: { createQueryBuilder: () => builder } as any, batches };
}

describe('日志级别闸门（默认 WARN）', () => {
    let service: LoggingService;

    /** 队列长度 —— 直接看私有字段：本文件要断言的正是「有没有进队列」 */
    const queueLen = () => (service as any).queue.length as number;

    beforeEach(() => {
        service = new LoggingService(makeRepo().repo);
    });

    afterEach(() => {
        // scheduleFlush 的定时器已 unref，清掉只是不让 jest 报 open handle
        const t = (service as any).flushTimer;
        if (t) clearTimeout(t);
    });

    it('INFO 在入队前就被丢掉——队列里一条都没有', async () => {
        await service.write(makeEntry(AppLogLevel.INFO, '预约创建成功'));
        expect(queueLen()).toBe(0);
    });

    it('DEBUG 同样丢弃', async () => {
        await service.write(makeEntry(AppLogLevel.DEBUG));
        expect(queueLen()).toBe(0);
    });

    it('WARN / ERROR 正常入队', async () => {
        await service.write(makeEntry(AppLogLevel.WARN, '预约核验失败'));
        await service.write(makeEntry(AppLogLevel.ERROR, '支付回调业务处理失败'));
        expect(queueLen()).toBe(2);
    });

    it('writeMany 逐条过滤，只保留达标的', async () => {
        await service.writeMany([
            makeEntry(AppLogLevel.INFO),
            makeEntry(AppLogLevel.DEBUG),
            makeEntry(AppLogLevel.WARN),
            makeEntry(AppLogLevel.ERROR),
        ]);
        expect(queueLen()).toBe(2);
    });
});

describe('日志级别闸门：stdout 回退路径', () => {
    let service: LoggingService;
    let logToStdout: jest.SpyInstance;

    beforeEach(() => {
        service = new LoggingService(makeRepo().repo);
        (service as any).sqliteEnabled = false; // 走 stdout 回退
        logToStdout = jest.spyOn(service as any, 'logToStdout').mockImplementation(() => undefined);
    });

    it('INFO 既不落库也不进 stdout', async () => {
        await service.write(makeEntry(AppLogLevel.INFO));

        expect(logToStdout).not.toHaveBeenCalled();
    });

    it('ERROR 走 stdout', async () => {
        await service.write(makeEntry(AppLogLevel.ERROR));

        expect(logToStdout).toHaveBeenCalledTimes(1);
    });

    it('writeMany 在 stdout 路径下同样过滤', async () => {
        await service.writeMany([makeEntry(AppLogLevel.INFO), makeEntry(AppLogLevel.ERROR)]);

        expect(logToStdout).toHaveBeenCalledTimes(1);
        expect(logToStdout.mock.calls[0][0].level).toBe(AppLogLevel.ERROR);
    });
});

describe('小程序批量上报（persistClientBatch）', () => {
    let service: LoggingService;
    let batches: AppLog[][];

    beforeEach(() => {
        const made = makeRepo();
        batches = made.batches;
        service = new LoggingService(made.repo);
    });

    it('被级别丢掉的那些**仍然回执为 accepted**——否则小程序会一直重传', async () => {
        const res = await service.persistClientBatch([
            makeEntry(AppLogLevel.INFO, '页面加载'),
            makeEntry(AppLogLevel.ERROR, '接口失败'),
        ]);

        // 回执必须覆盖**提交的全部**，不能只覆盖真正落库的那些
        expect(res.acceptedLogIds).toHaveLength(2);
        // 但落库的只有 ERROR 一条
        expect(batches).toHaveLength(1);
        expect(batches[0]).toHaveLength(1);
        expect(batches[0][0].level).toBe(AppLogLevel.ERROR);
    });

    it('整批都被过滤 → 不触发写事务，回执照样是全部', async () => {
        const res = await service.persistClientBatch([
            makeEntry(AppLogLevel.INFO),
            makeEntry(AppLogLevel.DEBUG),
        ]);

        expect(res.acceptedLogIds).toHaveLength(2);
        expect(batches).toHaveLength(0);
    });
});

/**
 * 阈值本身通过环境变量注入，且是**模块加载时读取一次**（与 `sqliteEnabled` 同款，
 * 改完要重启）。所以这里用 isolateModules 重新加载模块来模拟不同的启动配置。
 */
describe('APP_LOG_MIN_LEVEL 配置解析', () => {
    const loadWith = (value: string | undefined): LoggingService => {
        let svc!: LoggingService;
        jest.isolateModules(() => {
            if (value === undefined) delete process.env.APP_LOG_MIN_LEVEL;
            else process.env.APP_LOG_MIN_LEVEL = value;
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const mod = require('./logging.service') as typeof import('./logging.service');
            svc = new mod.LoggingService(makeRepo().repo);
        });
        return svc;
    };

    const queueLen = (svc: LoggingService) => (svc as any).queue.length as number;

    afterEach(() => {
        delete process.env.APP_LOG_MIN_LEVEL;
    });

    it('=error 时 WARN 也被丢掉（只留 ERROR）', async () => {
        const svc = loadWith('error');

        await svc.write(makeEntry(AppLogLevel.WARN));
        await svc.write(makeEntry(AppLogLevel.ERROR));

        expect(queueLen(svc)).toBe(1);
        expect((svc as any).queue[0].entry.level).toBe(AppLogLevel.ERROR);
    });

    it('=info 时 INFO 恢复写入（不重启代码就能调回来）', async () => {
        const svc = loadWith('info');

        await svc.write(makeEntry(AppLogLevel.INFO));

        expect(queueLen(svc)).toBe(1);
    });

    for (const bad of ['warning', 'verbose', 'true', '', '  ']) {
        it(`=「${bad}」是非法值 → 回落 WARN，不会把日志全关掉`, async () => {
            const svc = loadWith(bad);

            await svc.write(makeEntry(AppLogLevel.INFO));
            await svc.write(makeEntry(AppLogLevel.WARN));

            expect(queueLen(svc)).toBe(1);
            expect((svc as any).queue[0].entry.level).toBe(AppLogLevel.WARN);
        });
    }

    it('容忍首尾空白：=「 error 」等同 error（.env 里带尾空格很常见）', async () => {
        const svc = loadWith(' error ');

        await svc.write(makeEntry(AppLogLevel.WARN));
        await svc.write(makeEntry(AppLogLevel.ERROR));

        expect(queueLen(svc)).toBe(1);
        expect((svc as any).queue[0].entry.level).toBe(AppLogLevel.ERROR);
    });

    it('大小写不敏感：=WaRn 等同 warn', async () => {
        const svc = loadWith('WaRn');

        await svc.write(makeEntry(AppLogLevel.INFO));
        await svc.write(makeEntry(AppLogLevel.WARN));

        expect(queueLen(svc)).toBe(1);
    });
});
