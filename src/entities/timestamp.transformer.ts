import { ValueTransformer } from 'typeorm';

/**
 * 将 Date 对象与 Unix 毫秒时间戳互转
 * 存入 SQLite：Date → number（毫秒）
 * 读出 SQLite：number → Date
 */
export const timestampTransformer: ValueTransformer = {
    to: (value: Date | null | undefined): number | null => {
        if (value == null) return null;
        return value instanceof Date ? value.getTime() : new Date(value).getTime();
    },
    from: (value: number | null | undefined): Date | null => {
        if (value == null) return null;
        return new Date(value);
    },
};
