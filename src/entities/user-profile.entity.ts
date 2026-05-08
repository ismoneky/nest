import { Entity, Column, PrimaryGeneratedColumn, Index, BeforeInsert, BeforeUpdate } from 'typeorm';
import { timestampTransformer } from './timestamp.transformer';

@Entity('user_profiles')
@Index(['wechatOpenId'])
export class UserProfile {
    @PrimaryGeneratedColumn()
    id: number;

    @Column({ unique: true })
    profileId: string;

    @Column()
    @Index()
    wechatOpenId: string;

    @Column()
    name: string;

    @Column()
    phone: string;

    @Column()
    idCard: string;

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
