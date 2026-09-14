import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AdminApplicationRepository } from '../../repositories/admin-application.repository';
import { AdminApplication, AdminApplicationStatus } from '../../entities/admin-application.entity';

@Injectable()
export class AdminApplicationService {
    constructor(private readonly adminApplicationRepository: AdminApplicationRepository) {}

    async apply(openid: string, phone: string, name: string): Promise<AdminApplication> {
        const existing = await this.adminApplicationRepository.findPendingByOpenid(openid);
        if (existing) {
            throw new BadRequestException('您已有一个待审核的申请');
        }
        return this.adminApplicationRepository.createApplication(openid, phone, name);
    }

    async listApplications(status?: AdminApplicationStatus): Promise<AdminApplication[]> {
        return this.adminApplicationRepository.findAll(status);
    }

    async approveApplication(applicationId: string): Promise<AdminApplication> {
        const application = await this.adminApplicationRepository.findByApplicationId(applicationId);
        if (!application) {
            throw new NotFoundException('申请不存在');
        }
        if (application.status !== AdminApplicationStatus.PENDING) {
            throw new BadRequestException('该申请已被处理');
        }
        return this.adminApplicationRepository.approve(applicationId);
    }

    async rejectApplication(applicationId: string, rejectionReason?: string): Promise<AdminApplication> {
        const application = await this.adminApplicationRepository.findByApplicationId(applicationId);
        if (!application) {
            throw new NotFoundException('申请不存在');
        }
        if (application.status !== AdminApplicationStatus.PENDING) {
            throw new BadRequestException('该申请已被处理');
        }
        return this.adminApplicationRepository.reject(applicationId, rejectionReason);
    }
}
