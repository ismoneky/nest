import { Entity, Column, PrimaryGeneratedColumn, Index, BeforeInsert } from 'typeorm';
import { timestampTransformer } from './timestamp.transformer';

@Entity('feedbacks')
export class Feedback {
    @PrimaryGeneratedColumn()
    id: number;

    @Column({ unique: true })
    @Index()
    feedbackId: string;

    @Column()
    @Index()
    wechatOpenId: string;

    @Column()
    phone: string;

    @Column({ type: 'text' })
    content: string;

    @Column({ type: 'integer', transformer: timestampTransformer, default: () => `${Date.now()}` })
    createdAt: Date;

    @BeforeInsert()
    setCreatedAt() {
        if (!this.createdAt) this.createdAt = new Date();
    }
}
