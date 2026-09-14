/**
 * 身份证号归一化：统一转为大写并去首尾空白
 * 用于身份证比较与写入，避免大小写 X 导致的匹配失败（如会员存大写 X、乘客填小写 x）
 */
export const normalizeIdCard = (s: string | undefined | null): string => (s ?? '').toUpperCase().trim();
