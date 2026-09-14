/**
 * 2A 链路冒烟：过期扫描 / 核销互斥 / 取消 / 退款闸门
 * 在临时库上跑，绝不触碰 data/prod.db。可重复执行（日期按今天相对推算）。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataSource } from 'typeorm';
import {
    Booking, BookingStatus, PaymentStatus, RefundStatus, TimeSlot, TravelMode,
} from '../src/entities/booking.entity';
import { BookingAnomaly } from '../src/entities/booking-anomaly.entity';
import { BookingRepository } from '../src/repositories/booking.repository';
import { beijingDateStr, BookingService } from '../src/modules/booking/booking.service';

const rows: { id: string; date: string; status: BookingStatus; pay: PaymentStatus; refund: RefundStatus; desc: string; free?: boolean }[] = [];
let results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = '') { results.push({ name, ok, detail }); }

const shift = (d: string, n: number) => {
    const t = new Date(`${d}T00:00:00Z`);
    t.setUTCDate(t.getUTCDate() + n);
    return t.toISOString().slice(0, 10);
};

(async () => {
    const today = beijingDateStr();
    const yest = shift(today, -1);
    const tmrw = shift(today, 1);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-smoke-2a-'));
    const dbPath = path.join(dir, 'smoke.db');
    const ds = new DataSource({ type: 'sqlite', database: dbPath, synchronize: true, entities: [Booking, BookingAnomaly] });
    await ds.initialize();                       // synchronize 建表：等价于生产结构，无需任何真实数据
    const raw = ds.getRepository(Booking);
    const repo = new BookingRepository(raw, ds.getRepository(BookingAnomaly), ds);

    console.log(`临时库: ${dbPath}（synchronize 建表）`);
    console.log(`今天=${today}  昨天=${yest}  明天=${tmrw}\n`);

    // ① 造数据：覆盖 8 种组合
    const seed: [string, string, BookingStatus, PaymentStatus, RefundStatus, string, boolean?][] = [
        ['A', yest, BookingStatus.CONFIRMED, PaymentStatus.PAID, RefundStatus.NONE, '昨天未核销 → 应下沉 expired'],
        ['B', today, BookingStatus.CONFIRMED, PaymentStatus.PAID, RefundStatus.NONE, '今天 → 不下沉，且今天仍可核销'],
        ['C', tmrw, BookingStatus.CONFIRMED, PaymentStatus.PAID, RefundStatus.NONE, '明天 → 不下沉'],
        ['D', yest, BookingStatus.COMPLETED, PaymentStatus.PAID, RefundStatus.NONE, '昨天已核销 → 不动'],
        ['E', yest, BookingStatus.CONFIRMED, PaymentStatus.PAID, RefundStatus.REFUNDING, '昨天退款中 → 不动（修 §8-4 缺陷）'],
        ['F', yest, BookingStatus.PENDING, PaymentStatus.UNPAID, RefundStatus.NONE, '昨天待支付 → 不动'],
        ['G', yest, BookingStatus.CONFIRMED, PaymentStatus.PAID, RefundStatus.NONE, '昨天免费单 → 下沉，但无退款入口', true],
        ['H', yest, BookingStatus.EXPIRED, PaymentStatus.PAID, RefundStatus.NONE, '已过期 → 重复跑不重复统计'],
    ];
    for (const [id, date, st, pay, rf, desc, free] of seed) {
        await raw.save(raw.create({
            bookingId: `SMOKE-${id}`, wechatOpenId: 'openid-smoke', name: '冒烟', phone: '13800000000',
            bookingDate: new Date(`${date}T00:00:00`) as any, timeSlot: TimeSlot.MORNING,
            travelMode: TravelMode.SELF_DRIVING, personCount: 1, remarks: '', isFree: !!free,
            status: st, paymentStatus: pay, refundStatus: rf,
        }));
        rows.push({ id: `SMOKE-${id}`, date, status: st, pay, refund: rf, desc, free });
    }
    const dump = async (title: string) => {
        const all = await raw.find({ order: { bookingId: 'ASC' } });
        console.log(`── ${title}`);
        for (const b of all) {
            const mark = b.status === 'expired' && b.expiredAt ? ` (expiredAt=${new Date(b.expiredAt).toISOString().slice(0, 16)}Z)` : '';
            const v = b.verifiedAt ? ` verifiedBy=${b.verifiedBy}` : '';
            console.log(`   ${b.bookingId}  ${String(b.bookingDate).slice(0, 10)}  ${b.status.padEnd(10)} pay=${b.paymentStatus.padEnd(8)} refund=${b.refundStatus}${mark}${v}`);
        }
        console.log('');
    };
    await dump('① 造数据后（初始状态）');

    // ② T1：标记位口径的过期扫描（cron 的步骤①本体）
    const affected = await repo.markExpired(today, Date.now());
    const after = await raw.find({ order: { bookingId: 'ASC' } });
    const expiredIds = after.filter((b) => b.status === BookingStatus.EXPIRED).map((b) => b.bookingId);
    check('T1 affected 命中数与预期一致', affected === 2, `affected=${affected}`);
    check('昨天未核销单下沉为 expired', expiredIds.includes('SMOKE-A'));
    check('今天/明天的单不下沉', !expiredIds.includes('SMOKE-B') && !expiredIds.includes('SMOKE-C'));
    check('已核销单不动', after.find((b) => b.bookingId === 'SMOKE-D')!.status === BookingStatus.COMPLETED);
    check('退款中的单不动（不是 completed/expired）', after.find((b) => b.bookingId === 'SMOKE-E')!.status === BookingStatus.CONFIRMED);
    check('待支付单不动', after.find((b) => b.bookingId === 'SMOKE-F')!.status === BookingStatus.PENDING);
    check('免费单也下沉（无退款入口由阶段 3 的 refundEntry 控制）', expiredIds.includes('SMOKE-G'));
    await dump('② 跑完 T1 之后');

    // ③ 幂等：再跑一次不应再改任何行
    const again = await repo.markExpired(today, Date.now());
    check('重复执行 T1 幂等（affected=0）', again === 0, `第二次 affected=${again}`);

    // ④ 核销：今天的单可核销并留痕
    const now = Date.now();
    check('今天订单核销成功（affected=1）', (await repo.markVerified('SMOKE-B', 'openid-staff', now)) === 1);
    const bRow = await raw.findOneOrFail({ where: { bookingId: 'SMOKE-B' } });
    check('核销写入 verifiedAt/verifiedBy', bRow.status === BookingStatus.COMPLETED && !!bRow.verifiedAt && bRow.verifiedBy === 'openid-staff');
    check('重复核销 affected=0', (await repo.markVerified('SMOKE-B', 'openid-staff', now)) === 0);

    // ⑤ 互斥：已被 T1 下沉的单不可补核销（Q2）
    check('已过期单不可补核销（affected=0）', (await repo.markVerified('SMOKE-A', 'openid-staff', now)) === 0);
    const aRow = await raw.findOneOrFail({ where: { bookingId: 'SMOKE-A' } });
    check('且状态没被写回 completed', aRow.status === BookingStatus.EXPIRED);

    // ⑥ 取消：待支付单可取消，终态与超时关单一致
    check('待支付单取消成功', (await repo.markCancelledByUser('SMOKE-F')) === 1);
    const fRow = await raw.findOneOrFail({ where: { bookingId: 'SMOKE-F' } });
    check('取消终态 = cancelled + failed + 清空调度', fRow.status === BookingStatus.CANCELLED && fRow.paymentStatus === PaymentStatus.FAILED && fRow.reconcileKind === null);
    check('重复取消 affected=0', (await repo.markCancelledByUser('SMOKE-F')) === 0);

    // ⑦ 退款闸门（阶段 3 之后有两层，职责不同，两条都要在）
    //
    // 仓库层：`markRefundStarting` 已在阶段 3 **有意放开** `expired`——不放开的
    // 话审核通过后的退款永远发不出去（过期单条件不匹配，恒 affected=0）。
    // 所以这条断言的方向是「必须成功」，它同时是「有人误把条件改回去」的守卫。
    check('过期单进得了 REFUNDING（阶段 3 有意放开，审核路径依赖）', (await repo.markRefundStarting('SMOKE-H', 'RFSMOKE-H', now)) === 1);

    // 服务层：用户自助退款在 `initiateRefund` 里被 Q1 拦下。仓库层放开之后，
    // **这一道是过期订单唯一的自助退款拦截面**，必须端到端验证（而不是只测 service 的单元）。
    const svc = new BookingService(
        repo,
        null as any, // wechatPayService
        null as any, // systemConfigService
        null as any, // adminApplicationRepository
        null as any, // dataSource
        null as any, // memberService
        null as any, // userProfileRepository
        // loggingService：链路失败时它会写日志，给 null 会让真正的错误被
        // 「Cannot read properties of null」盖住（第一次跑就是这样）
        { write: () => Promise.resolve() } as any,
        null as any, // refundApplyRepository
        null as any, // messageService
    );
    const selfService = await svc
        .initiateRefund('SMOKE-A', 'openid-smoke')
        .then(() => null, (e: Error) => e.message);
    check('【关键】用户自助退款在服务层被 Q1 拦下', /需经管理员审核/.test(selfService ?? ''), `msg=${selfService}`);
    const aAfter = await raw.findOneOrFail({ where: { bookingId: 'SMOKE-A' } });
    check('且未写入 REFUNDING（确认不是"报错但已落库"）', aAfter.refundStatus === RefundStatus.NONE);

    // 审核路径（asAdmin）不该被 Q1 文案拦住——它要继续往下走去调微信
    const adminPath = await svc
        .initiateRefund('SMOKE-A', '', { asAdmin: true, outRefundNo: 'RFSMOKE-A-2' })
        .then(() => null, (e: Error) => e.message);
    check('审核路径不被 Q1 拦截（错误不应是 Q1 文案）', !/需经管理员审核/.test(adminPath ?? ''), `msg=${adminPath}`);

    check('退款中的单不会被 T1 下沉', (await repo.markExpired(today, Date.now())) === 0);
    await dump('③ 全部操作之后（最终状态）');

    const failed = results.filter((r) => !r.ok);
    console.log('── 断言结果');
    for (const r of results) console.log(`   ${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? `  [${r.detail}]` : ''}`);
    console.log(`\n${results.length - failed.length}/${results.length} 通过`);
    await ds.destroy();
    process.exit(failed.length ? 1 : 0);
})();
