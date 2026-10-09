import { BadRequestException } from '@nestjs/common';

export const GUIDE_CATEGORIES = ['spot', 'station', 'camp', 'parking', 'toilet', 'entrance'] as const;
export type GuideCategory = typeof GUIDE_CATEGORIES[number];

export interface GuidePoint {
    id: string;
    name: string;
    categories: GuideCategory[];
    description: string;
    imageUrl: string;
    x: number;
    y: number;
    visible: boolean;
    sortOrder: number;
    latitude: number;
    longitude: number;
    address: string;
}

export interface GuideContent {
    title: string;
    imageUrl: string;
    imageWidth: number;
    imageHeight: number;
    points: GuidePoint[];
}

export interface GuideDocument extends GuideContent {
    revision: number;
    updatedAt: number | null;
}

export const defaultGuide = (): GuideDocument => ({
    title: '风车天路景区导览',
    imageUrl: '',
    imageWidth: 0,
    imageHeight: 0,
    points: [],
    revision: 0,
    updatedAt: null,
});

const fail = (message: string): never => { throw new BadRequestException(message); };
const object = (value: unknown, label: string): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(`${label}格式不正确`);
    return value as Record<string, unknown>;
};
const text = (value: unknown, label: string, max: number, required = false): string => {
    if (value === undefined && !required) return '';
    if (typeof value !== 'string') return fail(`${label}必须为文字`);
    const result = value.trim();
    if ((required && !result) || result.length > max) return fail(`${label}${required ? '不能为空且' : ''}不能超过${max}字`);
    return result;
};
const number = (value: unknown, label: string, min: number, max: number, integer = false): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
        return fail(`${label}须为${min}到${max}之间的${integer ? '整数' : '数字'}`);
    }
    return value;
};
const imageUrl = (value: unknown, label: string, required = false): string => {
    const url = text(value, label, 2048, required);
    if (!url && !required) return '';
    try {
        const parsed = new URL(url);
        if (parsed.protocol === 'https:' && parsed.hostname && !parsed.username && !parsed.password) return url;
    } catch { /* reported below */ }
    return fail(`${label}请使用 HTTPS 图片链接`);
};

/** Explicit validation avoids the global DTO pipe coercing "false" into true. */
export function parseGuide(input: unknown): GuideContent & { revision: number } {
    const data = object(input, '导览配置');
    const revision = number(data.revision, '配置版本', 0, Number.MAX_SAFE_INTEGER, true);
    const title = text(data.title, '导览标题', 60, true);
    const url = imageUrl(data.imageUrl, '导览底图', true);
    const imageWidth = number(data.imageWidth, '图片宽度', 1, 20000, true);
    const imageHeight = number(data.imageHeight, '图片高度', 1, 20000, true);
    if (!Array.isArray(data.points) || data.points.length > 100) return fail('地点列表最多支持100个地点');
    const ids = new Set<string>();
    const points = data.points.map((value, index): GuidePoint => {
        const p = object(value, `第${index + 1}个地点`);
        const id = text(p.id, '地点编号', 80, true);
        if (!/^[a-zA-Z0-9_-]+$/.test(id) || ids.has(id)) return fail('地点编号格式不正确或重复');
        ids.add(id);
        const name = text(p.name, `第${index + 1}个地点名称`, 60, true);
        if (!Array.isArray(p.categories) || !p.categories.length || p.categories.length > GUIDE_CATEGORIES.length || p.categories.some(c => !GUIDE_CATEGORIES.includes(c as GuideCategory))) {
            return fail(`${name}请选择有效分类`);
        }
        if (typeof p.visible !== 'boolean') return fail(`${name}的显示状态必须为布尔值`);
        const result: GuidePoint = {
            id, name, categories: [...new Set(p.categories)] as GuideCategory[],
            description: text(p.description, `${name}简介`, 500),
            imageUrl: imageUrl(p.imageUrl, `${name}配图`),
            x: number(p.x, `${name}横坐标`, 0, 1),
            y: number(p.y, `${name}纵坐标`, 0, 1),
            visible: p.visible,
            sortOrder: number(p.sortOrder, `${name}排序`, 0, 9999, true),
            latitude: number(p.latitude, `${name}纬度`, -90, 90),
            longitude: number(p.longitude, `${name}经度`, -180, 180),
            address: text(p.address, `${name}地址`, 200),
        };
        return result;
    });
    const result = { title, imageUrl: url, imageWidth, imageHeight, points, revision };
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 180 * 1024) return fail('导览内容过大，请缩短地点简介或图片链接');
    return result;
}
