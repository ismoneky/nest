import { Entity, Column, PrimaryGeneratedColumn, Index, BeforeInsert, BeforeUpdate } from 'typeorm';
import { timestampTransformer } from './timestamp.transformer';

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
    @Column({ type: 'integer', nullable: true, transformer: timestampTransformer })
    lastLoginAt?: Date;

    /** 创建时间 */
    @Column({ type: 'integer', transformer: timestampTransformer, default: () => `${Date.now()}` })
    createdAt: Date;

    /** 更新时间 */
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
