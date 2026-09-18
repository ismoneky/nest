import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';

/**
 * 日志级别
 */
export enum AppLogLevel {
    DEBUG = 'debug',
    INFO = 'info',
    WARN = 'warn',
    ERROR = 'error',
}

/**
 * 日志来源
 */
export enum AppLogSource {
    BACKEND = 'backend',
    MINIPROGRAM = 'miniprogram',
    ADMIN = 'admin',
}

/**
 * 日志分类
 */
export enum AppLogCategory {
    REQUEST = 'request',
    BOOKING = 'booking',
    PAYMENT = 'payment',
    NETWORK = 'network',
    UI = 'ui',
    RUNTIME = 'runtime',
}

/**
 * 轻量日志（独立 logs.db 的 app_logs 表）
 * bookingId/requestId 等关联字段只保存为普通字符串，不与 prod.db 建立外键，不做跨库 JOIN。
 * 建表 SQL 见 docs/implementation-todo.md「生产 schema 变更 SQL（手工执行）」第 5 节。
 */
@Entity('app_logs')
export class AppLog {
    @PrimaryGeneratedColumn()
    id: number;

    /** 日志唯一标识，用于客户端重试去重 */
    @Column({ type: 'varchar' })
    @Index({ unique: true })
    logId: string;

    /** backend | miniprogram | admin */
    @Column({ type: 'varchar' })
    source: AppLogSource;

    /** debug | info | warn | error */
    @Column({ type: 'varchar' })
    level: AppLogLevel;

    /** request | booking | payment | network | ui | runtime */
    @Column({ type: 'varchar' })
    category: AppLogCategory;

    /** 简短日志消息，最多 2,000 个字符 */
    @Column({ type: 'varchar' })
    message: string;

    /** 服务端请求关联标识 */
    @Column({ type: 'varchar', nullable: true })
    @Index()
    requestId: string;

    /** 小程序匿名会话标识 */
    @Column({ type: 'varchar', nullable: true })
    @Index()
    sessionId: string;

    /** 页面路由或后端请求路径 */
    @Column({ type: 'varchar', nullable: true })
    route: string;

    /** 已过滤的结构化上下文，最多 8 KiB */
    @Column({ type: 'text', nullable: true })
    contextJson: string;

    /** 小程序版本 */
    @Column({ type: 'varchar', nullable: true })
    appVersion: string;

    /** 微信客户端与系统平台摘要 */
    @Column({ type: 'varchar', nullable: true })
    platform: string;

    /** 客户端产生日志的时间（毫秒 epoch） */
    @Column({ type: 'integer', nullable: true })
    clientCreatedAt: number;

    /** 服务端接收或产生日志的时间（毫秒 epoch） */
    @Column({ type: 'integer' })
    createdAt: number;
}
