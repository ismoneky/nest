import { Test } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Feedback } from '../entities/feedback.entity';
import { FeedbackRepository } from './feedback.repository';

/**
 * 反馈列表的排序：**第一页必须是最新的**
 *
 * ── 为什么要写这个 ────────────────────────────────────────────────────────
 * 后台「反馈统计」是客户端分页（一次取全量，Table 自己切页），
 * 所以**页序完全等于接口返回的数组顺序** —— 排序一旦不是 DESC，
 * 运营第一眼看到的就是最老的那批反馈，而新反馈沉在最后一页。
 * 这种错不会报错、不会告警，只会让人以为「最近没人反馈」。
 *
 * `createdAt` 是 integer + 毫秒时间戳。若 ORDER BY 缺失，
 * SQLite 会按 rowid（插入顺序）返回，正好就是**最老的在前** ——
 * 与期望完全相反，且看起来「像是排了序」。
 *
 * 夹具为虚构数据。
 */
describe('反馈列表排序', () => {
    let repository: FeedbackRepository;
    let repo: Repository<Feedback>;

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({
            imports: [
                TypeOrmModule.forRoot({
                    type: 'sqlite',
                    database: ':memory:',
                    synchronize: true,
                    dropSchema: true,
                    entities: [Feedback],
                }),
                TypeOrmModule.forFeature([Feedback]),
            ],
            providers: [FeedbackRepository],
        }).compile();

        repository = moduleRef.get(FeedbackRepository);
        repo = moduleRef.get(getRepositoryToken(Feedback));
    });

    beforeEach(async () => {
        await repo.clear();
    });

    /** 直接落库并指定 createdAt —— 绕开 @BeforeInsert，才能构造出与插入顺序相反的时序 */
    const seed = async (phone: string, createdAtMs: number) => {
        await repo.save(
            repo.create({
                feedbackId: `FB-${phone}`,
                wechatOpenId: `openid-${phone}`,
                phone,
                content: `${phone} 的反馈`,
                createdAt: new Date(createdAtMs),
            }),
        );
    };

    it('返回顺序是时间倒序（最新在前）', async () => {
        // 刻意按「中 → 旧 → 新」插入：如果只按 rowid 返回，结果会是中、旧、新
        const base = Date.parse('2026-09-15T10:00:00.000Z');
        await seed('13800000002', base);                    // 中间
        await seed('13800000001', base - 60 * 60 * 1000);  // 最旧
        await seed('13800000003', base + 60 * 60 * 1000);  // 最新

        const list = await repository.findAll();

        expect(list.map((f) => f.phone)).toEqual([
            '13800000003', // 最新
            '13800000002',
            '13800000001', // 最旧
        ]);
    });

    it('第一条就是全表最新的那条', async () => {
        const base = Date.parse('2026-09-15T10:00:00.000Z');
        for (let i = 0; i < 5; i++) {
            await seed(`1380000000${i}`, base - i * 1000); // 越后插入的越旧
        }

        const list = await repository.findAll();

        expect(list[0].phone).toBe('1380000000' + '0');
    });

    /**
     * ⚠️ 这一条才是最关键的：上面那些用例都是**手工指定 createdAt** 喂进去的，
     * 绕开了 `@BeforeInsert`。真实提交路径（`createFeedback`）不传 createdAt，
     * 值全靠监听器补 —— 监听器若没生效，TypeORM 会退到列默认值上，
     * 而 `default: () => ${Date.now()}` 是**建表那一刻求值一次**的常量：
     * 于是所有行的 createdAt 完全相同，ORDER BY 变成空操作，
     * SQLite 按 rowid 返回 = 最老的在前。**看起来像排了序，其实是最坏的那种。**
     */
    it('走真实创建路径：每条的 createdAt 是各自插入的时刻，不是同一个常量', async () => {
        const first = await repository.createFeedback('openid-a', '13800000001', 'A');
        await new Promise((resolve) => setTimeout(resolve, 5)); // 让两次插入的时刻可分
        const second = await repository.createFeedback('openid-b', '13800000002', 'B');

        const t1 = new Date(first.createdAt).getTime();
        const t2 = new Date(second.createdAt).getTime();

        expect(Number.isFinite(t1)).toBe(true);
        expect(Number.isFinite(t2)).toBe(true);
        expect(t2).toBeGreaterThan(t1);
    });

    it('走真实创建路径：返回顺序同样是新的在前', async () => {
        await repository.createFeedback('openid-a', '13800000001', '最旧');
        await new Promise((resolve) => setTimeout(resolve, 5));
        await repository.createFeedback('openid-b', '13800000002', '最新');

        const list = await repository.findAll();

        expect(list[0].phone).toBe('13800000002');
    });

    it('同一毫秒的多条 → 按 id 倒序兜底，顺序稳定（后插入的在前）', async () => {
        const same = Date.parse('2026-09-15T10:00:00.000Z');
        // 三条时间戳完全相同
        await seed('13800000001', same);
        await seed('13800000002', same);
        await seed('13800000003', same);

        const first = await repository.findAll();
        const second = await repository.findAll();

        // id 自增，与插入顺序同向 → 倒序即「后插入的在前」，且两次调用结果一致
        expect(first.map((f) => f.phone)).toEqual(['13800000003', '13800000002', '13800000001']);
        expect(second.map((f) => f.phone)).toEqual(first.map((f) => f.phone));
    });

    it('createdAt 真的落成了毫秒时间戳（不是字符串、不是秒）', async () => {
        const ms = Date.parse('2026-09-15T10:00:00.000Z');
        await seed('13800000009', ms);

        // 绕过 transformer 读原始列值：排序依赖的是这个数值
        const raw = await repo.query('SELECT createdAt FROM feedbacks WHERE phone = ?', ['13800000009']);

        expect(raw[0].createdAt).toBe(ms);
    });
});
