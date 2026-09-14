import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { AdminApplication, AdminApplicationStatus } from '../entities/admin-application.entity';
import { serialSave, serialWrite } from '../common/transaction-runner';

@Injectable()
export class AdminApplicationRepository {
    constructor(
        @InjectRepository(AdminApplication)
        private readonly repo: Repository<AdminApplication>,
    ) {}

    async createApplication(openid: string, phone: string, name: string): Promise<AdminApplication> {
        const application = this.repo.create({
            applicationId: randomUUID(),
            openid,
            phone,
            name,
            status: AdminApplicationStatus.PENDING,
        });
        return serialSave(this.repo, application);
    }

    async findPendingByOpenid(openid: string): Promise<AdminApplication | null> {
        return this.repo.findOne({
            where: { openid, status: AdminApplicationStatus.PENDING },
        });
    }

    async findApprovedByOpenid(openid: string): Promise<AdminApplication | null> {
        return this.repo.findOne({
            where: { openid, status: AdminApplicationStatus.APPROVED },
        });
    }

    /**
     * 按 openid 批量取「已通过」管理员的姓名（核销人展示用）
     *
     * 存在的理由只有一个：`bookings.verifiedBy` 存的是核销员的 openid，
     * 直接丢到界面上是一串 28 位随机字符，管理员和用户都读不出「谁核的」。
     *
     * 一次 `IN (...)` 查完，不做 N+1 —— 后台订单列表一页最多 100 行，
     * 每行一次查询在单连接 SQLite 上是实打实的排队。
     *
     * 查不到**不是错误**：历史数据的 openid 可能对不上、申请单可能已被删。
     * 返回的 Map 里没有这个 key，由调用方决定回落文案 ——
     * 一个查不到的名字不该让整页订单打不开。
     */
    async findApprovedNamesByOpenids(openids: string[]): Promise<Map<string, string>> {
        const unique = [...new Set(openids.filter(Boolean))];
        if (unique.length === 0) return new Map();

        const rows = await this.repo.find({
            where: { openid: In(unique), status: AdminApplicationStatus.APPROVED },
            select: ['openid', 'name'],
        });
        return new Map(rows.map((row) => [row.openid, row.name]));
    }

    async findAll(status?: AdminApplicationStatus): Promise<AdminApplication[]> {
        if (status) {
            return this.repo.find({ where: { status }, order: { createdAt: 'DESC' } });
        }
        return this.repo.find({ order: { createdAt: 'DESC' } });
    }

    async findByApplicationId(applicationId: string): Promise<AdminApplication | null> {
        return this.repo.findOne({ where: { applicationId } });
    }

    async approve(applicationId: string): Promise<AdminApplication> {
        // repo.update() 是 QueryBuilder 的快捷写法，同样不自开事务 —— 不排队就会被并发事务的回滚带走
        await serialWrite(this.repo.manager.connection, () =>
            this.repo.update({ applicationId }, { status: AdminApplicationStatus.APPROVED }),
        );
        return this.repo.findOne({ where: { applicationId } });
    }

    async reject(applicationId: string, rejectionReason?: string): Promise<AdminApplication> {
        await serialWrite(this.repo.manager.connection, () =>
            this.repo.update(
                { applicationId },
                { status: AdminApplicationStatus.REJECTED, rejectionReason: rejectionReason || null },
            ),
        );
        return this.repo.findOne({ where: { applicationId } });
    }
}
