import { Injectable } from '@nestjs/common';
import { AnnouncementRepository } from '../../repositories/announcement.repository';
import { CreateAnnouncementDto } from './dto/create-announcement.dto';
import { UpdateAnnouncementDto } from './dto/update-announcement.dto';

@Injectable()
export class AnnouncementService {
    constructor(private readonly repository: AnnouncementRepository) {}

    async create(dto: CreateAnnouncementDto) {
        return await this.repository.create(dto);
    }

    async findAll() {
        return await this.repository.findAll();
    }

    async findActive() {
        return await this.repository.findActive();
    }

    async findById(id: string) {
        return await this.repository.findById(id);
    }

    async update(id: string, dto: UpdateAnnouncementDto) {
        return await this.repository.update(id, dto);
    }

    async delete(id: string) {
        return await this.repository.delete(id);
    }
}
