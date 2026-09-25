import { Entity, Column, PrimaryGeneratedColumn, Index, BeforeInsert, BeforeUpdate } from 'typeorm';
import { timestampTransformer } from './timestamp.transformer';

@Entity('users')
@Index('IDX_users_unionid', ['wechatUnionId'], { unique: true })
export class User {
    @PrimaryGeneratedColumn()
    id: number;

    @Column({ unique: true })
    @Index()
    userId: string;

    @Column({ unique: true })
    @Index()
    wechatOpenId: string;

    @Column({ type: 'varchar', nullable: true })
    wechatUnionId: string | null;

    /** 冲突只冻结服务号关联，不影响小程序登录。 */
    @Column({ type: 'integer', default: 0 })
    wechatIdentityConflict: number;

    @Column({ nullable: true })
    wechatNickname?: string;

    @Column({ nullable: true })
    wechatAvatarUrl?: string;

    @Column({ type: 'integer', transformer: timestampTransformer, default: () => `${Date.now()}` })
    createdAt: Date;

    @Column({ type: 'integer', transformer: timestampTransformer, default: () => `${Date.now()}` })
    updatedAt: Date;

    @BeforeInsert()
    setCreatedAt() {
        const now = new Date();
        if (!this.createdAt) this.createdAt = now;
        this.updatedAt = now;
    }

    @BeforeUpdate()
    setUpdatedAt() {
        this.updatedAt = new Date();
    }
}
