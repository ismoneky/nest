import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * 管理员实体
 */
@Entity('admins')
export class Admin {
    @PrimaryGeneratedColumn()
    id: number;

    /** 管理员用户名 (唯一) */
    @Column({ unique: true })
    @Index()
    username: string;

    /** 密码 (加密存储) */
    @Column()
    password: string;

    /** 管理员姓名 */
    @Column()
    name: string;

    /** 最后登录时间 */
    @Column({ type: 'datetime', nullable: true })
    lastLoginAt?: Date;

    /** 创建时间 */
    @CreateDateColumn()
    createdAt: Date;

    /** 更新时间 */
    @UpdateDateColumn()
    updatedAt: Date;
}
