import { Test } from '@nestjs/testing';
import { DataSource, Repository } from 'typeorm';
import { AdminApplication } from '../../entities/admin-application.entity';
import { BookingService } from './booking.service';
import { BookingRepository } from '../../repositories/booking.repository';
import { AdminApplicationRepository } from '../../repositories/admin-application.repository';
import { RefundApplyRepository } from '../../repositories/refund-apply.repository';
import { UserProfileRepository } from '../../repositories/user-profile.repository';
import { WechatPayService } from '../wechat-pay/wechat-pay.service';
import { SystemConfigService } from '../system-config/system-config.service';
import { MemberService } from '../member/member.service';
import { LoggingService } from '../logging/logging.service';
import { MessageService } from '../message/message.service';
import { BookingStatus } from '../../entities/booking.entity';

/**
 * 核销人姓名解析（`attachVerifierNames`）
 *
 * ── 这个文件锁的是失败模式，不是功能 ──────────────────────────────────────
 * `bookings.verifiedBy` 落的是核销员的 openid，要在界面上显示成人名，就得在
 * 响应出去之前解析一次 `admin_applications.name`。这一步夹在**后台订单列表**
 * 和**小程序订单详情**两条主链路的返回路径上，所以：
 *
 *   1. **解析不到 → null，不抛**。历史数据的 openid 对不上、申请单被删，
 *      都不该让订单列表打不开；
 *   2. **解析本身挂了 → 也不抛**。姓名是装饰，为了「谁核的」把运营的主入口
 *      整个 500 掉不值当；
 *   3. **非 completed 不查库**。`verifiedBy` 只可能由 `markVerified` 写入，
 *      其余状态必为 null —— 后台列表一页最多 100 行、小程序详情 5 秒轮询一次，
 *      白查是常态开销；
 *   4. **一页只查一次**（批量），不是每行一次；
 *   5. **不原地改入参**。调用方（订单详情）拿的是 `[withVerifier]` 解构出来的
 *      新对象再展开进响应里，原地改会让「原始实体」和「发出去的」混为一谈。
 *
 * 用替身而不是真库：这里要断言的是「查了几次、传了什么进去」，
 * 不是「SQLite 的 IN 能不能用」——后者是 TypeORM 的事。
 * 夹具为虚构数据，不含真实用户信息。
 */
describe('核销人姓名解析（attachVerifierNames）', () => {
    let service: BookingService;
    let findApprovedNamesByOpenids: jest.Mock;

    /** 一行待挂姓名的订单；只填本方法真正读到的两个字段 */
    const row = (over: Record<string, unknown> = {}) => ({
        bookingId: 'TL-20260915-001',
        status: BookingStatus.COMPLETED as BookingStatus,
        verifiedBy: 'openid-verifier-zhang',
        ...over,
    });

    beforeAll(async () => {
        findApprovedNamesByOpenids = jest.fn();

        const moduleRef = await Test.createTestingModule({
            providers: [
                BookingService,
                // 本文件只碰 attachVerifierNames，它只用到 adminApplicationRepository，
                // 其余协作者给空壳即可（与 admin-tasks-endpoint.spec.ts 同款）
                { provide: BookingRepository, useValue: {} },
                { provide: WechatPayService, useValue: {} },
                { provide: SystemConfigService, useValue: {} },
                { provide: AdminApplicationRepository, useValue: { findApprovedNamesByOpenids } },
                { provide: DataSource, useValue: {} },
                { provide: MemberService, useValue: {} },
                { provide: UserProfileRepository, useValue: {} },
                { provide: LoggingService, useValue: {} },
                { provide: RefundApplyRepository, useValue: {} },
                { provide: MessageService, useValue: {} },
            ],
        }).compile();

        service = moduleRef.get(BookingService);
    });

    beforeEach(() => {
        findApprovedNamesByOpenids.mockReset();
        findApprovedNamesByOpenids.mockResolvedValue(new Map());
    });

    it('completed 且解析得出姓名 → 挂上 verifiedByName，原始 openid 保留', async () => {
        findApprovedNamesByOpenids.mockResolvedValue(new Map([['openid-verifier-zhang', '张三']]));

        const [out] = await service.attachVerifierNames([row()]);

        expect(out.verifiedByName).toBe('张三');
        // openid 必须留着：后台在解析不到姓名时要回落到显示它来追责
        expect(out.verifiedBy).toBe('openid-verifier-zhang');
    });

    it('解析不出姓名 → null（不抛、也不编一个）', async () => {
        // 库里没有这个 openid 对应的已通过申请：历史数据、申请单被删都会这样
        findApprovedNamesByOpenids.mockResolvedValue(new Map());

        const [out] = await service.attachVerifierNames([row()]);

        expect(out.verifiedByName).toBeNull();
        expect(out.verifiedBy).toBe('openid-verifier-zhang');
    });

    it('非 completed → 一次库都不查', async () => {
        const rows = [
            row({ status: BookingStatus.CONFIRMED, verifiedBy: null }),
            row({ status: BookingStatus.EXPIRED, verifiedBy: null }),
            row({ status: BookingStatus.CANCELLED, verifiedBy: null }),
            row({ status: BookingStatus.PENDING, verifiedBy: null }),
        ];

        const out = await service.attachVerifierNames(rows);

        expect(findApprovedNamesByOpenids).not.toHaveBeenCalled();
        expect(out.every((r) => r.verifiedByName === null)).toBe(true);
    });

    it('completed 但 verifiedBy 为空（历史数据）→ 不查库，直接 null', async () => {
        const out = await service.attachVerifierNames([row({ verifiedBy: null })]);

        expect(findApprovedNamesByOpenids).not.toHaveBeenCalled();
        expect(out[0].verifiedByName).toBeNull();
    });

    it('一页多行只查一次，不是每行一次', async () => {
        findApprovedNamesByOpenids.mockResolvedValue(new Map([['openid-verifier-zhang', '张三']]));

        const out = await service.attachVerifierNames([
            row({ bookingId: 'A' }),
            row({ bookingId: 'B' }),
            row({ bookingId: 'C' }),
        ]);

        expect(findApprovedNamesByOpenids).toHaveBeenCalledTimes(1);
        expect(out.every((r) => r.verifiedByName === '张三')).toBe(true);
    });

    it('解析这一步挂掉（库异常）→ 不抛，全部回落 null —— 订单列表照常返回', async () => {
        findApprovedNamesByOpenids.mockRejectedValue(new Error('database is locked'));

        const out = await service.attachVerifierNames([row({ bookingId: 'A' }), row({ bookingId: 'B' })]);

        expect(out).toHaveLength(2);
        expect(out.every((r) => r.verifiedByName === null)).toBe(true);
        // 订单本身的数据一个都不能少——装饰失败不能吃掉正文
        expect(out[0].bookingId).toBe('A');
        expect(out[0].verifiedBy).toBe('openid-verifier-zhang');
    });

    it('不原地改入参：返回的是新对象', async () => {
        const input = row();
        const [out] = await service.attachVerifierNames([input]);

        expect(out).not.toBe(input);
        expect('verifiedByName' in input).toBe(false);
    });

    it('空数组 → 不查库，返回空数组', async () => {
        const out = await service.attachVerifierNames([]);

        expect(out).toEqual([]);
        expect(findApprovedNamesByOpenids).not.toHaveBeenCalled();
    });
});

/**
 * 仓储层：`IN (...)` 批量取姓名的去重与空值处理
 *
 * 与上面分开是因为失败模式不同——上面测「策略」，这里测「SQL 之前的参数整形」。
 */
describe('AdminApplicationRepository.findApprovedNamesByOpenids 的参数整形', () => {
    let repo: AdminApplicationRepository;
    let find: jest.Mock;

    beforeAll(() => {
        find = jest.fn().mockResolvedValue([]);
        // 直接 new：本文件测的是「进 IN 之前怎么整形」，
        // 用 Nest 的 overrideProvider 会把整个实例换掉，真实方法就测不到了
        repo = new AdminApplicationRepository({ find } as unknown as Repository<AdminApplication>);
    });

    beforeEach(() => {
        find.mockReset();
        find.mockResolvedValue([]);
    });

    it('空数组/全空值 → 直接返回空 Map，不发查询', async () => {
        expect(await repo.findApprovedNamesByOpenids([])).toEqual(new Map());
        expect(await repo.findApprovedNamesByOpenids(['', null as unknown as string])).toEqual(new Map());
        expect(find).not.toHaveBeenCalled();
    });

    it('重复 openid 去重后才进 IN', async () => {
        await repo.findApprovedNamesByOpenids(['a', 'b', 'a', 'a']);

        expect(find).toHaveBeenCalledTimes(1);
        const where = find.mock.calls[0][0].where;
        // TypeORM 的 In() 包成 FindOperator，取它的 value 比字符串比对稳
        expect(where.openid.value).toEqual(['a', 'b']);
    });

    it('返回 openid → 姓名 的映射', async () => {
        find.mockResolvedValue([
            { openid: 'a', name: '张三' },
            { openid: 'b', name: '李四' },
        ]);

        const names = await repo.findApprovedNamesByOpenids(['a', 'b']);

        expect(names.get('a')).toBe('张三');
        expect(names.get('b')).toBe('李四');
    });
});
