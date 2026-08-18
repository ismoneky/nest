import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { AdminApplication, AdminApplicationStatus } from '../entities/admin-application.entity';

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
        return this.repo.save(application);
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
        await this.repo.update({ applicationId }, { status: AdminApplicationStatus.APPROVED });
        return this.repo.findOne({ where: { applicationId } });
    }

    async reject(applicationId: string, rejectionReason?: string): Promise<AdminApplication> {
        await this.repo.update(
            { applicationId },
            { status: AdminApplicationStatus.REJECTED, rejectionReason: rejectionReason || null },
        );
        return this.repo.findOne({ where: { applicationId } });
    }
}
