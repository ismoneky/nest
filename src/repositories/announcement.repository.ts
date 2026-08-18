import { Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Announcement } from '../entities/announcement.entity';
import { CreateAnnouncementDto } from '../modules/announcement/dto/create-announcement.dto';
import { UpdateAnnouncementDto } from '../modules/announcement/dto/update-announcement.dto';
import { randomUUID } from 'crypto';

/**
 * 公告数据访问层
 */
@Injectable()
export class AnnouncementRepository {
    constructor(
        @InjectRepository(Announcement)
        private readonly announcementRepository: Repository<Announcement>,
    ) {}

    /**
     * 创建公告
     */
    async create(dto: CreateAnnouncementDto): Promise<Announcement> {
        try {
            const announcement = this.announcementRepository.create({
                announcementId: randomUUID(),
                ...dto,
            });
            return await this.announcementRepository.save(announcement);
        } catch (error) {
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to create announcement');
        }
    }

    /**
     * 查询所有公告 (管理端)
     */
    async findAll(): Promise<Announcement[]> {
        try {
            return await this.announcementRepository.find({
                order: {
                    sortOrder: 'ASC',
                    createdAt: 'DESC',
                },
            });
        } catch (error) {
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to find all announcements');
        }
    }

    /**
     * 查询启用的公告 (小程序端)
     */
    async findActive(): Promise<Announcement[]> {
        try {
            return await this.announcementRepository.find({
                where: { isActive: true },
                order: {
                    sortOrder: 'ASC',
                    createdAt: 'DESC',
                },
            });
        } catch (error) {
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to find active announcements');
        }
    }

    /**
     * 根据ID查询
     */
    async findById(announcementId: string): Promise<Announcement> {
        try {
            const announcement = await this.announcementRepository.findOne({
                where: { announcementId },
            });
            if (!announcement) {
                throw new NotFoundException('公告不存在');
            }
            return announcement;
        } catch (error) {
            if (error instanceof NotFoundException) {
                throw error;
            }
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to find announcement');
        }
    }

    /**
     * 更新公告
     */
    async update(announcementId: string, dto: UpdateAnnouncementDto): Promise<Announcement> {
        try {
            const announcement = await this.findById(announcementId);
            Object.assign(announcement, dto);
            return await this.announcementRepository.save(announcement);
        } catch (error) {
            if (error instanceof NotFoundException) {
                throw error;
            }
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to update announcement');
        }
    }

    /**
     * 删除公告
     */
    async delete(announcementId: string): Promise<Announcement> {
        try {
            const announcement = await this.findById(announcementId);
            return await this.announcementRepository.remove(announcement);
        } catch (error) {
            if (error instanceof NotFoundException) {
                throw error;
            }
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to delete announcement');
        }
    }
}
