import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Message, OaSendStatus } from '../entities/message.entity';
import { serialWrite } from '../common/transaction-runner';

export type OaSettlement = Pick<Message, 'oaSendStatus'> & Partial<Pick<Message,
    'oaNextAttemptAt' | 'oaLastError' | 'oaMsgId' | 'oaSkipReason'>>;

@Injectable()
export class OaDeliveryRepository {
    constructor(@InjectRepository(Message) private readonly repo: Repository<Message>) {}

    due(now: number): Promise<Message[]> {
        return this.repo.createQueryBuilder('m').where('m.oaSendStatus = :status', { status: OaSendStatus.PENDING })
            .andWhere('(m.oaNextAttemptAt IS NULL OR m.oaNextAttemptAt <= :now)', { now })
            .orderBy('m.oaNextAttemptAt', 'ASC').addOrderBy('m.id', 'ASC').take(20).getMany();
    }

    async claim(id: number, now: number): Promise<boolean> {
        const result = await serialWrite(this.repo.manager.connection, () => this.repo.createQueryBuilder().update(Message)
            .set({ oaSendStatus: OaSendStatus.SENDING, oaClaimedAt: now, updatedAt: new Date(now) })
            .where('id = :id AND oaSendStatus = :pending', { id, pending: OaSendStatus.PENDING })
            .andWhere('(oaNextAttemptAt IS NULL OR oaNextAttemptAt <= :now)', { now }).execute());
        return result.affected === 1;
    }

    async recordAttempt(id: number, claimedAt: number): Promise<boolean> {
        const result = await serialWrite(this.repo.manager.connection, () => this.repo.createQueryBuilder().update(Message)
            .set({ oaAttempts: () => 'oaAttempts + 1', updatedAt: new Date() })
            .where('id = :id AND oaSendStatus = :sending AND oaClaimedAt = :claimedAt', { id, sending: OaSendStatus.SENDING, claimedAt })
            .andWhere('oaAttempts < 3').andWhere('oaExpiresAt > :now', { now: Date.now() }).execute());
        return result.affected === 1;
    }

    async settle(id: number, claimedAt: number, patch: OaSettlement): Promise<void> {
        const result = await serialWrite(this.repo.manager.connection, () => this.repo.createQueryBuilder().update(Message)
            .set({ oaNextAttemptAt: null, oaLastError: null, oaSkipReason: null, ...patch, oaClaimedAt: null, updatedAt: new Date() })
            .where('id = :id AND oaSendStatus = :sending AND oaClaimedAt = :claimedAt', { id, sending: OaSendStatus.SENDING, claimedAt }).execute());
        if (result.affected !== 1) throw new Error('OA_CLAIM_LOST');
    }

    async recoverInterrupted(now: number): Promise<void> {
        await serialWrite(this.repo.manager.connection, () => this.repo.createQueryBuilder().update(Message)
            .set({ oaSendStatus: OaSendStatus.UNKNOWN, oaLastError: 'PROCESS_INTERRUPTED', oaClaimedAt: null, updatedAt: new Date(now) })
            .where('oaSendStatus = :sending', { sending: OaSendStatus.SENDING })
            .andWhere('(oaClaimedAt IS NULL OR oaClaimedAt <= :cutoff)', { cutoff: now - 120000 }).execute());
    }
}
