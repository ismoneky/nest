import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

@Entity('users')
export class User {
    @PrimaryGeneratedColumn()
    id: number;

    @Column({ unique: true })
    @Index()
    userId: string;

    @Column({ unique: true })
    @Index()
    wechatOpenId: string;

    @Column()
    wechatNickname: string;

    @Column({ nullable: true })
    wechatAvatarUrl?: string;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
