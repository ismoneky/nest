import { ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ScenicGuide } from '../../entities/scenic-guide.entity';
import { serialTransaction } from '../../common/transaction-runner';
import { defaultGuide, GuideContent, GuideDocument, parseGuide } from './scenic-guide.model';

@Injectable()
export class ScenicGuideService {
    constructor(@InjectRepository(ScenicGuide) private readonly repository: Repository<ScenicGuide>) {}

    private document(row: ScenicGuide | null): GuideDocument {
        if (!row) return defaultGuide();
        const content: GuideContent = JSON.parse(row.contentJson);
        return { ...content, revision: row.revision, updatedAt: row.updatedAt };
    }

    async read(admin = false): Promise<GuideDocument> {
        const doc = this.document(await this.repository.findOneBy({ id: 1 }));
        return {
            ...doc,
            points: doc.points.filter(p => admin || p.visible).sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id)),
        };
    }

    async save(input: unknown): Promise<GuideDocument> {
        const { revision, ...content } = parseGuide(input);
        return serialTransaction(this.repository.manager.connection, async manager => {
            const repo = manager.getRepository(ScenicGuide);
            const current = await repo.findOneBy({ id: 1 });
            if ((current?.revision || 0) !== revision) {
                throw new ConflictException('导览已被其他管理员更新，请先备份当前修改，再重新加载最新配置');
            }
            const row = await repo.save(repo.create({
                id: 1, contentJson: JSON.stringify(content), revision: revision + 1, updatedAt: Date.now(),
            }));
            return this.document(row);
        });
    }
}
