import { Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import {
    RefundApply,
    RefundApplyStatus,
    REFUND_APPLY_CONSUMED_STATUSES,
} from '../entities/refund-apply.entity';
import { serialSave } from '../common/transaction-runner';

/**
 * 审核列表的可选筛选条件
 *
 * `createdStart/createdEnd` 收的是 **`YYYY-MM-DD` 日期字符串**（与订单列表的
 * `GetBookingsAdminDto` 完全一致），由本仓库在边界处转成毫秒 epoch。
 * 不在 DTO 层转是因为「一天的边界」是数据访问口径（本地 00:00:00.000 / 23:59:59.999），
 * 放到 HTTP 层会让每个调用方各自实现一遍。与 `getBookingsForAdmin` 的四条查询同款。
 */
export interface RefundApplyQuery {
    status?: RefundApplyStatus;
    /** 申请日期下界（含当天），格式 YYYY-MM-DD */
    createdStart?: string;
    /** 申请日期上界（含当天），格式 YYYY-MM-DD */
    createdEnd?: string;
    keyword?: string;
    page?: number;
    pageSize?: number;
}

/**
 * `YYYY-MM-DD` → 当天 00:00:00.000（含）的毫秒 epoch。
 * 只取前 10 位，容忍调用方误传了带时间部分的 ISO 串。
 */
function dayStartMs(dateStr: string): number {
    const d = new Date(dateStr.substring(0, 10));
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

/**
 * `YYYY-MM-DD` → 当天 23:59:59.999（含）的毫秒 epoch
 */
function dayEndMs(dateStr: string): number {
    const d = new Date(dateStr.substring(0, 10));
    d.setHours(23, 59, 59, 999);
    return d.getTime();
}

/**
 * 退款申请单数据访问层
 *
 * 转换协议与其他仓库一致：**只提供带期望状态条件的原子更新（返回 affected rows）**，
 * 不决定业务转换。审核的「通过/拒绝」是条件 UPDATE（`WHERE status='pending'`），
 * 并发下两个管理员同时点通过时只有一个 affected=1，另一个拿到 0 并收到「已被处理」。
 */
@Injectable()
export class RefundApplyRepository {
    constructor(
        @InjectRepository(RefundApply)
        private readonly refundApplyRepository: Repository<RefundApply>,
    ) {}

    /**
     * 生成申请单号（业务主键）
     * 格式与订单号 TLxxxx 同构，前缀 RA（Refund Apply）便于日志里一眼区分
     */
    private generateApplyNo(): string {
        return `RA${randomUUID().replace(/-/g, '').substring(0, 11).toUpperCase()}`;
    }

    /**
     * 新建申请单
     *
     * 调用方需自行保证 `applyCount` 不与既有单据冲突；冲突时由
     * `IDX_refund_applies_booking_count` 唯一索引直接拒绝（并发重复提交的最终兜底）。
     *
     * @param data 申请内容（applyCount / reason / refundAmount 由 service 计算后传入）
     * @returns 落库后的申请单
     */
    async createApply(data: {
        bookingId: string;
        wechatOpenId: string;
        applyCount: number;
        reason: string;
        refundAmount: number;
    }): Promise<RefundApply> {
        try {
            const apply = this.refundApplyRepository.create({
                applyNo: this.generateApplyNo(),
                ...data,
                status: RefundApplyStatus.PENDING,
            });
            return await serialSave(this.refundApplyRepository, apply);
        } catch (error) {
            throw new InternalServerErrorException(
                error instanceof Error ? error.message : 'Failed to create refund apply',
            );
        }
    }

    /**
     * 按申请单号查询
     */
    async getByApplyNo(applyNo: string): Promise<RefundApply> {
        try {
            const apply = await this.refundApplyRepository.findOne({ where: { applyNo } });
            if (!apply) {
                throw new NotFoundException(`RefundApply ${applyNo} not found`);
            }
            return apply;
        } catch (error) {
            if (error instanceof NotFoundException) throw error;
            throw new InternalServerErrorException(
                error instanceof Error ? error.message : 'Failed to get refund apply',
            );
        }
    }

    /**
     * 按微信退款单号查询（退款回调/对账收敛用）
     *
     * 返回 null 而不是抛错：旧链路（用户自助退款、管理员直接退款）产生的退款单
     * 没有对应的申请单，回调拿到 `outRefundNo` 时查不到是**正常路径**，不是异常。
     */
    async findByOutRefundNo(outRefundNo: string): Promise<RefundApply | null> {
        try {
            return await this.refundApplyRepository.findOne({ where: { outRefundNo } });
        } catch (error) {
            throw new InternalServerErrorException(
                error instanceof Error ? error.message : 'Failed to find refund apply by outRefundNo',
            );
        }
    }

    /**
     * 某订单的最新一条申请（订单详情展示态与退款入口显隐都只看最新一条）
     */
    async findLatestByBookingId(bookingId: string): Promise<RefundApply | null> {
        try {
            return await this.refundApplyRepository.findOne({
                where: { bookingId },
                order: { applyCount: 'DESC' },
            });
        } catch (error) {
            throw new InternalServerErrorException(
                error instanceof Error ? error.message : 'Failed to find latest refund apply',
            );
        }
    }

    /**
     * 某订单的全部申请（审核详情页展示「用户历史申请」用，时间正序）
     */
    async findAllByBookingId(bookingId: string): Promise<RefundApply[]> {
        try {
            return await this.refundApplyRepository.find({
                where: { bookingId },
                order: { applyCount: 'ASC' },
            });
        } catch (error) {
            throw new InternalServerErrorException(
                error instanceof Error ? error.message : 'Failed to get refund applies',
            );
        }
    }

    /**
     * 某用户在某订单上的退款申请列表
     */
    async findByOpenId(wechatOpenId: string, bookingId?: string): Promise<RefundApply[]> {
        try {
            const where: any = { wechatOpenId };
            if (bookingId) where.bookingId = bookingId;
            return await this.refundApplyRepository.find({
                where,
                order: { createdAt: 'DESC' },
            });
        } catch (error) {
            throw new InternalServerErrorException(
                error instanceof Error ? error.message : 'Failed to get my refund applies',
            );
        }
    }

    /**
     * 是否存在「进行中」的申请单（pending / approved）
     *
     * 这是防重复提交的判定条件，同时也是订单详情 `refundEntry.visible` 的第 4 条。
     * 只查进行中：已拒绝/已失败的单不阻塞用户重新申请。
     */
    async hasOpenApply(bookingId: string): Promise<boolean> {
        const count = await this.refundApplyRepository.count({
            where: {
                bookingId,
                status: In([RefundApplyStatus.PENDING, RefundApplyStatus.APPROVED]),
            },
        });
        return count > 0;
    }

    /**
     * 是否存在「被驳回」的申请单
     *
     * **驳回是终态**（2026-09-13 决策）：一旦有驳回记录，该订单不再开放申请入口，
     * 用户该做的是联系管理员。所以这个判断同时是入口显隐与提交拦截的条件之一。
     *
     * 与 `hasOpenApply` 分开而不是合成一个「有无不可申请记录」：
     * 两者的原因码不同（`APPLY_REJECTED` vs `APPLY_IN_PROGRESS`），
     * 前端文案与用户该做的事完全不同。
     */
    async hasRejectedApply(bookingId: string): Promise<boolean> {
        const count = await this.refundApplyRepository.count({
            where: { bookingId, status: RefundApplyStatus.REJECTED },
        });
        return count > 0;
    }

    /**
     * 已消耗的申请次数（pending / approved / success / failed）
     *
     * 被驳回（rejected）不计入——但驳回同时是**终态**（见 `hasRejectedApply`），
     * 所以这个口径差异已不影响用户能申请几次：有驳回记录的单根本不再开放入口。
     * 口径来源是实体上的 `REFUND_APPLY_CONSUMED_STATUSES`。
     */
    async countConsumedApplies(bookingId: string): Promise<number> {
        return this.refundApplyRepository.count({
            where: { bookingId, status: In(REFUND_APPLY_CONSUMED_STATUSES) },
        });
    }

    /**
     * 该订单当前已用的最大序号（含已驳回）。
     *
     * 序号分配与「已消耗次数」刻意用两个不同的口径：
     * `applyCount` 必须**单调递增且永不重复**（唯一索引依赖它），
     * 而额度只看 `countConsumedApplies`。若用消耗次数当序号，
     * 「申请→驳回→再申请→驳回」会算出重复序号撞唯一索引。
     */
    async maxApplyCount(bookingId: string): Promise<number> {
        const row = await this.refundApplyRepository
            .createQueryBuilder('apply')
            .select('MAX(apply.applyCount)', 'maxCount')
            .where('apply.bookingId = :bookingId', { bookingId })
            .getRawOne<{ maxCount: number | null }>();
        return row?.maxCount ?? 0;
    }

    /**
     * 管理员审核通过：pending → approved，同时落审核人与本次退款单号。
     *
     * 条件更新：`WHERE status='pending'`。两个管理员并发点「通过」时只有一个 affected=1，
     * 另一个拿到 0 → 上层报「该申请已被处理，请刷新」。**这是审核互斥的唯一保证**，
     * 上层的读-判-写不是。
     */
    async markApproved(
        applyNo: string,
        audit: { outRefundNo: string; adminId: number | null; adminName: string | null; remark: string | null; at: number },
    ): Promise<number> {
        return (await this.refundApplyRepository
            .createQueryBuilder()
            .update(RefundApply)
            .set({
                status: RefundApplyStatus.APPROVED,
                outRefundNo: audit.outRefundNo,
                auditAdminId: audit.adminId,
                auditAdminName: audit.adminName,
                auditRemark: audit.remark,
                auditAt: new Date(audit.at),
                // 条件更新走 QueryBuilder，@BeforeUpdate 钩子不触发，updatedAt 必须显式写。
                // 与全仓 QueryBuilder.update 的惯例一致（实体上的 @BeforeUpdate 只覆盖 save 路径）。
                updatedAt: new Date(audit.at),
            })
            .where('applyNo = :applyNo', { applyNo })
            .andWhere('status = :status', { status: RefundApplyStatus.PENDING })
            .execute()).affected ?? 0;
    }

    /**
     * 管理员审核拒绝：pending → rejected，拒绝理由必填（服务端已校验非空）
     */
    async markRejected(
        applyNo: string,
        audit: { rejectReason: string; adminId: number | null; adminName: string | null; remark: string | null; at: number },
    ): Promise<number> {
        return (await this.refundApplyRepository
            .createQueryBuilder()
            .update(RefundApply)
            .set({
                status: RefundApplyStatus.REJECTED,
                rejectReason: audit.rejectReason,
                auditAdminId: audit.adminId,
                auditAdminName: audit.adminName,
                auditRemark: audit.remark,
                auditAt: new Date(audit.at),
                updatedAt: new Date(audit.at),
            })
            .where('applyNo = :applyNo', { applyNo })
            .andWhere('status = :status', { status: RefundApplyStatus.PENDING })
            .execute()).affected ?? 0;
    }

    /**
     * 资金结果回写：approved → success / failed。
     *
     * 幂等：已是终态（success/failed）时 `WHERE status='approved'` 不匹配 → affected=0，
     * 调用方直接忽略。**必须幂等**——退款回调、15 分钟对账 Cron、异常通道重试
     * 三条路径都会调用它，同一个 apply 被收敛多次是常态。
     *
     * 只处理 approved：pending 的单子（还没审核）不该被资金结果改写；
     * rejected 的单子更不该——那说明这条退款单不属于本申请（outRefundNo 反查已限定）。
     */
    async markSettled(applyNo: string, success: boolean): Promise<number> {
        return (await this.refundApplyRepository
            .createQueryBuilder()
            .update(RefundApply)
            .set({
                status: success ? RefundApplyStatus.SUCCESS : RefundApplyStatus.FAILED,
                updatedAt: new Date(),
            })
            .where('applyNo = :applyNo', { applyNo })
            .andWhere('status = :status', { status: RefundApplyStatus.APPROVED })
            .execute()).affected ?? 0;
    }

    /**
     * 管理员审核列表（分页，支持状态/时间/关键字筛选）
     *
     * `isTimeout` 由上层按 `createdAt` 计算，不落库——它是**相对当前时刻**的派生值，
     * 落库必然过期（见 §4.3.3 审核 SLA：pending 超 48h 由 T4 提醒）。
     */
    async getForAdmin(query: RefundApplyQuery) {
        try {
            const page = query.page || 1;
            const pageSize = query.pageSize || 10;
            const skip = (page - 1) * pageSize;

            const qb = this.refundApplyRepository
                .createQueryBuilder('apply')
                // createdAt + id 双排序，保证同毫秒申请单顺序稳定，分页不重复/不丢行
                .orderBy('apply.createdAt', 'DESC')
                .addOrderBy('apply.id', 'DESC')
                .skip(skip)
                .take(pageSize);

            if (query.status) {
                qb.andWhere('apply.status = :status', { status: query.status });
            }
            if (query.createdStart) {
                qb.andWhere('apply.createdAt >= :createdStart', { createdStart: dayStartMs(query.createdStart) });
            }
            if (query.createdEnd) {
                qb.andWhere('apply.createdAt <= :createdEnd', { createdEnd: dayEndMs(query.createdEnd) });
            }
            if (query.keyword) {
                qb.andWhere('(apply.applyNo LIKE :kw OR apply.bookingId LIKE :kw)', { kw: `%${query.keyword}%` });
            }

            const [applies, total] = await qb.getManyAndCount();

            return {
                applies,
                total,
                page,
                pageSize,
                totalPages: Math.ceil(total / pageSize),
            };
        } catch (error) {
            throw new InternalServerErrorException(
                error instanceof Error ? error.message : 'Failed to get refund applies for admin',
            );
        }
    }
}
