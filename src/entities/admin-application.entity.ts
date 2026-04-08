import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

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

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
