import { Entity, Column, PrimaryGeneratedColumn, Index, BeforeInsert, BeforeUpdate } from 'typeorm';
import { timestampTransformer } from './timestamp.transformer';

export enum AdminApplicationStatus {
    PENDING = 'pending',
    APPROVED = 'approved',
    REJECTED = 'rejected',
}

@Entity('admin_applications')
export class AdminApplication {
    @PrimaryGeneratedColumn()
    id: number;

    @Column({ unique: true })
    @Index()
    applicationId: string;

    @Column()
    @Index()
    openid: string;

    @Column()
    phone: string;

    @Column()
    name: string;

    @Column({ type: 'varchar', default: AdminApplicationStatus.PENDING })
    @Index()
    status: AdminApplicationStatus;

    @Column({ nullable: true, type: 'text' })
    rejectionReason: string | null;

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
