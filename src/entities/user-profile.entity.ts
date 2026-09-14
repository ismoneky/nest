import { Entity, Column, PrimaryGeneratedColumn, Index, BeforeInsert, BeforeUpdate } from 'typeorm';
import { timestampTransformer } from './timestamp.transformer';

/**
 * ⚠️ `wechatOpenId` 上的索引**只声明一次**，在列上（下方 `@Index()`）。
 *
 * 这里曾经同时有类级 `@Index(['wechatOpenId'])` 和列级 `@Index()`：
 * TypeORM 的默认索引名只由「表名 + 列名」决定，两处算出的名字完全相同
 * （`IDX_509e7b1ba196e6202213b75eda`），于是 `synchronize` 会连着发两条
 * 一模一样的 `CREATE INDEX`，第二条报
 * `SQLITE_ERROR: index ... already exists` —— **任何全新数据库都建不起来**
 * （开发环境首次启动即失败；生产因为 `synchronize=false`、建表走手写 SQL，
 * 反而看不出问题）。已核实手写 SQL 里这个索引只建了一次，故删掉类级那条，
 * 生成的 schema 与之前完全一致。
 */
@Entity('user_profiles')
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
