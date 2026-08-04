import { Entity, Column, PrimaryGeneratedColumn, Index, BeforeInsert, BeforeUpdate } from 'typeorm';
import { timestampTransformer } from './timestamp.transformer';

/**
 * 会员状态枚举
 */
export enum MemberStatus {
    ACTIVE = 'active',     // 生效中
    EXPIRED = 'expired',   // 已过期
    DISABLED = 'disabled', // 已停用
}

/**
 * 月卡会员实体
 * 管理后台人工录入，绑定 wechatOpenId
 */
@Entity('members')
@Index(['wechatOpenId'])
@Index(['phone'])
export class Member {
    @PrimaryGeneratedColumn()
    id: number;

    /** 会员唯一标识 */
    @Column({ unique: true })
    memberId: string;

    /** 微信用户 OpenID（关联用户身份） */
    @Column()
    wechatOpenId: string;

    /** 会员姓名 */
    @Column()
    name: string;

    /** 会员手机号 */
    @Column()
    phone: string;

    /** 会员身份证号 */
    @Column()
    idCard: string;

    /** 会员状态 */
    @Column({ type: 'varchar', default: MemberStatus.ACTIVE })
    status: MemberStatus;

    /** 会员有效期开始时间 */
    @Column({ type: 'integer', transformer: timestampTransformer })
    startDate: Date;

    /** 会员有效期结束时间 */
    @Column({ type: 'integer', transformer: timestampTransformer })
    endDate: Date;

    /** 备注 */
    @Column({ default: '' })
    remarks: string;

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
