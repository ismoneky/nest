import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('user_wx_oa')
@Index('IDX_user_wx_oa_openid', ['oaAppId', 'oaOpenId'], { unique: true })
@Index('IDX_user_wx_oa_unionid', ['oaAppId', 'unionId'], { unique: true })
@Index('IDX_user_wx_oa_seen', ['oaAppId', 'lastSeenRunId'])
export class WechatOaFan {
    @PrimaryGeneratedColumn() id: number;
    @Column() oaAppId: string;
    @Column() oaOpenId: string;
    @Column({ type: 'varchar', nullable: true }) unionId: string | null;
    @Column({ type: 'integer', default: 0 }) identityConflict: number;
    @Column({ type: 'integer', default: 0 }) subscribed: number;
    @Column({ type: 'integer' }) subscriptionObservedAt: number;
    @Column({ type: 'varchar' }) lastSeenRunId: string;
    @Column({ type: 'integer', nullable: true }) lastInfoAt: number | null;
    @Column({ type: 'integer', nullable: true }) nextInfoRetryAt: number | null;
    @Column({ type: 'integer', default: 0 }) infoAttempts: number;
    @Column({ type: 'integer' }) createdAt: number;
    @Column({ type: 'integer' }) updatedAt: number;
}
