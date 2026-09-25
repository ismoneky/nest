import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('wx_oa_sync_runs')
@Index('IDX_wx_oa_sync_runs_status', ['oaAppId', 'status', 'startedAt'])
export class WechatOaSyncRun {
    @PrimaryColumn() runId: string;
    @Column() oaAppId: string;
    @Column() status: string;
    @Column({ type: 'integer' }) startedAt: number;
    @Column({ type: 'integer', nullable: true }) completedAt: number | null;
    @Column({ default: '' }) lastCursor: string;
    @Column({ type: 'integer', default: 0 }) seenCount: number;
    @Column({ type: 'integer', default: 0 }) infoSuccessCount: number;
    @Column({ type: 'integer', default: 0 }) infoFailureCount: number;
    @Column({ type: 'varchar', nullable: true }) lastError: string | null;
}
