import { Test } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Message, MessageType, MessageSenderType, OaSendStatus } from '../../entities/message.entity';
import { MessageRepository } from '../../repositories/message.repository';
import { MessageService } from './message.service';
import { beijingDateStr } from '../../common/date-utils';

/**
 * 阶段 4「站内信」的核心不变式测试。
 *
 * 锁定七件事：
 *   1. **去重的最终裁决权在唯一索引**：`createOnce` 撞索引时返回既有行且
 *      `created=false`——调用方靠 `created` 决定要不要发服务号推送，
 *      报错了就等于给用户重复推送；
 *   2. **退款类消息按申请单号去重，不是订单号**：这是 v2 修正 v1 的严重缺陷
 *      ——同一订单第 2、3 次申请必须各收到一条审核结果（回归测试见下方 describe）；
 *   3. **没有任何每日条数上限**（2026-09-15 起）：同一用户连发 6 条系统消息全部落库，
 *      消息只会被 `dedupeKey` 拦住；
 *   4. **`ADMIN_NOTICE` 与系统消息互不影响**：手动消息不去重，可无限多条；
 *   5. **归属隔离**：标记已读带 `userId` 条件，标记别人的消息是 affected=0 而不是越权；
 *   6. **OA 默认关闭**：不配任何环境变量时消息只落站内信，`oaSendStatus=SKIPPED`；
 *   7. **T3 治理**：30 天未读转已读（`readAt` 是治理时刻而非 cutoff）、90 天删除。
 *
 * 夹具均为虚构数据，不含真实用户信息。
 */
describe('阶段 4 站内信', () => {
    let service: MessageService;
    let repo: MessageRepository;
    let rawRepo: Repository<Message>;

    const USER = 'openid-msg-a';
    const OTHER = 'openid-msg-b';
    /** 北京 2026-09-13 12:00（= UTC 04:00），测试里所有「今天」都以它为基准 */
    const NOW = new Date('2026-09-13T04:00:00.000Z');

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({
            imports: [
                TypeOrmModule.forRoot({
                    type: 'sqlite',
                    database: ':memory:',
                    synchronize: true,
                    dropSchema: true,
                    entities: [Message],
                }),
                TypeOrmModule.forFeature([Message]),
            ],
            providers: [MessageRepository, MessageService],
        }).compile();

        service = moduleRef.get(MessageService);
        repo = moduleRef.get(MessageRepository);
        rawRepo = moduleRef.get(getRepositoryToken(Message));
    });

    beforeEach(async () => {
        await rawRepo.clear();
    });

    let seq = 0;

    /** 直接落库一条消息，用于精确控制 `createdAt`（服务层用的是 `new Date()`，注入不了） */
    async function seedRaw(over: Partial<Message> = {}): Promise<Message> {
        seq += 1;
        return await rawRepo.save(
            rawRepo.create({
                userId: USER,
                msgType: MessageType.ORDER_EXPIRED,
                title: '已过期',
                content: '正文',
                dedupeKey: `seed:${seq}`,
                senderType: MessageSenderType.SYSTEM,
                oaSendStatus: OaSendStatus.SKIPPED,
                oaAttempts: 0,
                isRead: 0,
                createdAt: NOW,
                updatedAt: NOW,
                ...over,
            }),
        );
    }

    // ═════════════════════════════════════════════════════════════════════════
    describe('幂等插入', () => {
        it('同一 dedupeKey 只落一行，第二次返回既有行且 created=false', async () => {
            const first = await repo.createOnce({
                userId: USER,
                msgType: MessageType.ORDER_EXPIRED,
                title: 'a',
                content: 'a',
                dedupeKey: 'ORDER_EXPIRED:B1',
            });
            expect(first.created).toBe(true);
            expect(first.message?.id).toBeDefined();

            const second = await repo.createOnce({
                userId: USER,
                msgType: MessageType.ORDER_EXPIRED,
                title: 'a',
                content: 'a',
                dedupeKey: 'ORDER_EXPIRED:B1',
            });

            expect(second.created).toBe(false);
            // 关键：拿回来的是**既有那一行**，不是 null、也不是别的行。
            // 若驱动返回的 identifiers 被误当成「本次插入的 id」，这里会指向错行
            expect(second.message?.id).toBe(first.message?.id);
            expect(await rawRepo.count()).toBe(1);
        });

        it('dedupeKey 为 NULL 时可以落多条（管理员手动消息）', async () => {
            const a = await repo.createOnce({
                userId: USER,
                msgType: MessageType.ADMIN_NOTICE,
                title: 'a',
                content: 'a',
                dedupeKey: null,
                senderType: MessageSenderType.ADMIN,
            });
            const b = await repo.createOnce({
                userId: USER,
                msgType: MessageType.ADMIN_NOTICE,
                title: 'b',
                content: 'b',
                dedupeKey: null,
                senderType: MessageSenderType.ADMIN,
            });

            expect(a.created).toBe(true);
            expect(b.created).toBe(true);
            expect(a.message?.id).not.toBe(b.message?.id);
            expect(await rawRepo.count()).toBe(2);
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    /**
     * v1 缺陷回归：退款类消息若按**订单号**去重，同一订单的第 2、3 次申请
     * 会算出完全相同的 key，第二条起全被静默去重——用户提交了申请，
     * 却永远收不到审核结果。这是 v1 最严重的一个缺陷（方案 §4.4 表注）。
     */
    describe('退款类消息按申请单号去重（v1 缺陷回归）', () => {
        it('同一订单的两次申请各收到一条审核结果', async () => {
            const bookingId = 'TL-MSG-1';

            const first = await service.send(MessageType.REFUND_APPROVED, {
                userId: USER,
                bookingId,
                bizNo: 'RA-1',
            });
            const second = await service.send(MessageType.REFUND_APPROVED, {
                userId: USER,
                bookingId,
                bizNo: 'RA-2',
            });

            expect(first.duplicated).toBe(false);
            expect(second.duplicated).toBe(false);
            expect(await rawRepo.count()).toBe(2);

            // 两条都能按申请单号反查到（bizId 是「指向哪个业务对象」）
            const rows = await rawRepo.find({ where: { userId: USER } });
            expect(rows.map((r) => r.bizId).sort()).toEqual(['RA-1', 'RA-2']);
        });

        it('同一次申请重复投递（回调重放）仍然只发一条', async () => {
            const ctx = { userId: USER, bookingId: 'TL-MSG-2', bizNo: 'RA-9' };
            await service.send(MessageType.REFUND_SUCCESS, { ...ctx, refundAmount: 12345 });
            const again = await service.send(MessageType.REFUND_SUCCESS, { ...ctx, refundAmount: 12345 });

            expect(again.duplicated).toBe(true);
            expect(await rawRepo.count()).toBe(1);
        });

        it('订单类消息按订单号去重：同一订单不会重复提醒过期', async () => {
            const ctx = { userId: USER, bookingId: 'TL-MSG-3' };
            await service.send(MessageType.ORDER_EXPIRED, ctx);
            const again = await service.send(MessageType.ORDER_EXPIRED, ctx);

            expect(again.duplicated).toBe(true);
            expect(await rawRepo.count()).toBe(1);
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    /**
     * 2026-09-15：原 §4.4「每用户每日 5 条系统消息」配额已整体删除（理由见
     * `MessageService.send` 的说明）。本 describe 锁的是「配额确实不在了」——
     * 旧实现在下面第一条用例的第 6 次发送会返回 `sent=false` 且不落库。
     *
     * 不能只放 5 条以内：那样新旧实现都能通过，用例锁不住任何东西。
     */
    describe('无每日条数上限（2026-09-15 起）', () => {
        it('同一用户连发 6 条系统消息全部落库', async () => {
            for (let i = 0; i < 6; i++) {
                const r = await service.send(MessageType.ORDER_EXPIRED, {
                    userId: USER,
                    bookingId: `TL-CAP-${i}`,
                });
                expect(r.sent).toBe(true);
                // 不同订单 → 不同 dedupeKey，一条都不该被判成重复
                expect(r.duplicated).toBe(false);
            }

            expect(await rawRepo.count()).toBe(6);
        });

        it('同一用户名下多张过期单会在同一批里各收一条（不再被配额推迟到次日）', async () => {
            // 这是删除配额的**产品动机**：每条消息都对应一张真实的过期订单，
            // 被挡下只会让「退款申请截止日」的提醒迟到
            await seedRaw({ dedupeKey: 'unrelated' });

            const a = await service.sendOrderExpired(
                { bookingId: 'TL-MULTI-1', wechatOpenId: USER },
                '2026-09-20',
            );
            const b = await service.sendOrderExpired(
                { bookingId: 'TL-MULTI-2', wechatOpenId: USER },
                '2026-09-20',
            );

            expect(a).toBe(true);
            expect(b).toBe(true);
            expect(await rawRepo.count()).toBe(3);
        });

        it('管理员手动消息照常落地，且可以同一个人连发多条', async () => {
            for (let i = 0; i < 6; i++) {
                await service.send(MessageType.ORDER_EXPIRED, { userId: USER, bookingId: `TL-ADM-${i}` });
            }

            const notice = await service.sendAdminNotice({
                openid: USER,
                title: '公告',
                content: '正文',
                adminId: 1,
            });
            const second = await service.sendAdminNotice({
                openid: USER,
                title: '公告 2',
                content: '正文 2',
                adminId: 1,
            });

            expect(notice).not.toBeNull();
            expect(notice?.senderType).toBe(MessageSenderType.ADMIN);
            // 手动消息的 dedupeKey 为 NULL：不去重，同一个人可以收到任意多条（§6）
            expect(second?.id).not.toBe(notice?.id);
            expect(await rawRepo.count()).toBe(8);
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    describe('归属隔离', () => {
        it('标记别人的消息为已读是 no-op，不会越权', async () => {
            const mine = await seedRaw({ userId: OTHER });

            const affected = await service.markRead(USER, [mine.id]);

            expect(affected).toBe(0);
            const after = await rawRepo.findOne({ where: { id: mine.id } });
            expect(after?.isRead).toBe(0);
        });

        it('全部已读只影响本人', async () => {
            await seedRaw({ userId: USER });
            await seedRaw({ userId: USER });
            const theirs = await seedRaw({ userId: OTHER });

            const affected = await service.markAllRead(USER);

            expect(affected).toBe(2);
            expect(await service.getUnreadCount(USER)).toBe(0);
            expect(await service.getUnreadCount(OTHER)).toBe(1);
            expect((await rawRepo.findOne({ where: { id: theirs.id } }))?.isRead).toBe(0);
        });

        it('列表只返回本人的消息', async () => {
            await seedRaw({ userId: USER });
            await seedRaw({ userId: OTHER });

            const result = await service.getMyMessages(USER, {});
            expect(result.total).toBe(1);
            expect(result.messages[0].userId).toBe(USER);
        });

        it('列表可按消息类型分组筛选（退款组 = 4 种 REFUND_*）', async () => {
            for (const t of [
                MessageType.REFUND_ACCEPTED,
                MessageType.REFUND_APPROVED,
                MessageType.REFUND_REJECTED,
                MessageType.REFUND_SUCCESS,
            ]) {
                seq += 1;
                await seedRaw({ msgType: t, dedupeKey: `grp:${seq}` });
            }
            await seedRaw({ msgType: MessageType.ORDER_EXPIRED, dedupeKey: 'grp:order' });

            const result = await service.getMyMessages(USER, {
                msgType: [
                    MessageType.REFUND_ACCEPTED,
                    MessageType.REFUND_APPROVED,
                    MessageType.REFUND_REJECTED,
                    MessageType.REFUND_SUCCESS,
                ],
            });
            expect(result.total).toBe(4);
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    describe('OA 通道默认关闭', () => {
        it('未配置 OA_ENABLED 时消息只落站内信，状态为 SKIPPED', async () => {
            const result = await service.send(MessageType.ORDER_EXPIRED, {
                userId: USER,
                bookingId: 'TL-OA-1',
            });

            expect(result.message?.oaSendStatus).toBe(OaSendStatus.SKIPPED);
            expect(result.message?.oaAttempts).toBe(0);
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    describe('T3 治理', () => {
        it('30 天前的未读转为已读，readAt 记治理时刻而不是 cutoff', async () => {
            const stale = await seedRaw({
                createdAt: new Date(NOW.getTime() - 31 * 24 * 60 * 60 * 1000),
            });
            const fresh = await seedRaw({ createdAt: new Date(NOW.getTime() - 60 * 60 * 1000) });

            const affected = await service.markStaleUnreadAsRead(NOW);

            expect(affected).toBe(1);
            const staleAfter = await rawRepo.findOne({ where: { id: stale.id } });
            expect(staleAfter?.isRead).toBe(1);
            // 写 cutoff 等于声称「用户 30 天前读过」，是假的
            expect(staleAfter?.readAt?.getTime()).toBe(NOW.getTime());
            expect((await rawRepo.findOne({ where: { id: fresh.id } }))?.isRead).toBe(0);
        });

        it('90 天前的消息被删除（含已读）', async () => {
            await seedRaw({ createdAt: new Date(NOW.getTime() - 91 * 24 * 60 * 60 * 1000), isRead: 1 });
            await seedRaw({ createdAt: new Date(NOW.getTime() - 89 * 24 * 60 * 60 * 1000) });

            const affected = await service.deleteExpired(NOW);

            expect(affected).toBe(1);
            expect(await rawRepo.count()).toBe(1);
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    describe('北京日工具函数', () => {
        it('beijingDateStr 在北京时间 00:00 翻页（而非 UTC 00:00）', () => {
            expect(beijingDateStr(new Date('2026-09-13T15:59:59.000Z'))).toBe('2026-09-13');
            expect(beijingDateStr(new Date('2026-09-13T16:00:00.000Z'))).toBe('2026-09-14');
        });

        // 原 `beijingDayStartMs` 的用例已随该函数删除（它唯一的使用方是每日配额统计）
    });
});
