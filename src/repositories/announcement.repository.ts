import { Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Announcement, AnnouncementDocument } from '../entities/announcement.entity';
import { CreateAnnouncementDto } from '../modules/announcement/dto/create-announcement.dto';
import { UpdateAnnouncementDto } from '../modules/announcement/dto/update-announcement.dto';
import { v4 as uuidv4 } from 'uuid';

/**
 * 公告数据访问层
 */
@Injectable()
export class AnnouncementRepository {
    constructor(@InjectModel(Announcement.name) private readonly announcementModel: Model<AnnouncementDocument>) {}

    /**
     * 创建公告
     */
    async create(dto: CreateAnnouncementDto) {
        try {
            const announcement = new this.announcementModel({
                announcementId: uuidv4(),
                ...dto,
            });
            const savedAnnouncement = await announcement.save();
            return savedAnnouncement.toObject();
        } catch (error) {
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to create announcement');
        }
    }

    /**
     * 查询所有公告 (管理端)
     */
    async findAll() {
        try {
            return await this.announcementModel.find().sort({ sortOrder: 1, createdAt: -1 }).lean().exec();
        } catch (error) {
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to find all announcements');
        }
    }

    /**
     * 查询启用的公告 (小程序端)
     */
    async findActive() {
        try {
            return await this.announcementModel.find({ isActive: true }).sort({ sortOrder: 1, createdAt: -1 }).lean().exec();
        } catch (error) {
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to find active announcements');
        }
    }

    /**
     * 根据ID查询
     */
    async findById(announcementId: string) {
        try {
            const announcement = await this.announcementModel.findOne({ announcementId }).lean().exec();
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
    async update(announcementId: string, dto: UpdateAnnouncementDto) {
        try {
            const announcement = await this.announcementModel.findOneAndUpdate({ announcementId }, dto, { new: true }).lean().exec();
            if (!announcement) {
                throw new NotFoundException('公告不存在');
            }
            return announcement;
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
    async delete(announcementId: string) {
        try {
            const result = await this.announcementModel.findOneAndDelete({ announcementId }).lean().exec();
            if (!result) {
                throw new NotFoundException('公告不存在');
            }
            return result;
        } catch (error) {
            if (error instanceof NotFoundException) {
                throw error;
            }
            throw new InternalServerErrorException(error instanceof Error ? error.message : 'Failed to delete announcement');
        }
    }
}
