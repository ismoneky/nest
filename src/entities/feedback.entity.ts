import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';

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

    @CreateDateColumn()
    createdAt: Date;
}
