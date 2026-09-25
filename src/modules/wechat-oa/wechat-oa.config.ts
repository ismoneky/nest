import { Injectable, Logger } from '@nestjs/common';
import { readFileSync } from 'fs';

export const OA_HTTP_TIMEOUT_MS = 10000;
export const OA_FAN_SYNC_CRON = '0 43 */2 * * *';
export const OA_TEMPLATE_TYPES = ['ORDER_EXPIRE_REMINDER', 'ORDER_EXPIRED', 'REFUND_ACCEPTED',
    'REFUND_APPROVED', 'REFUND_REJECTED', 'REFUND_SUCCESS'] as const;
export const OA_FIELD_SOURCES = ['bookingId', 'bizNo', 'refundAmount', 'rejectReason', 'applyDeadline', 'eventTime', 'status'] as const;
export type OaFieldSource = typeof OA_FIELD_SOURCES[number];
export interface OaTemplate {
    templateId: string;
    fields: Record<string, { source: OaFieldSource; maxLength: number }>;
}

/** 示例值只能用于配置说明，不能误开开关后向微信请求。 */
export function isPlaceholder(value: unknown): boolean {
    return typeof value !== 'string' || !value.trim() || /REPLACE|PLACEHOLDER|YOUR_|[<>]/i.test(value);
}

@Injectable()
export class WechatOaConfig {
    readonly sendEnabled = process.env.OA_ENABLED === 'true';
    readonly syncEnabled = process.env.OA_SYNC_ENABLED === 'true';
    readonly workerEnabled = process.env.OA_WORKER_ENABLED !== 'false';
    readonly appId = process.env.OA_APPID || '';
    readonly secret = process.env.OA_SECRET || '';
    readonly miniAppId = process.env.WX_APPID || '';
    readonly templates: Record<string, OaTemplate> = {};
    readonly configError: string | null = null;

    constructor() {
        if (this.sendEnabled && process.env.OA_TEMPLATES_FILE) {
            try {
                const parsed = JSON.parse(readFileSync(process.env.OA_TEMPLATES_FILE, 'utf8'));
                if (parsed.version !== 1 || !parsed.templates || typeof parsed.templates !== 'object' || Array.isArray(parsed.templates)) {
                    throw new Error('invalid schema');
                }
                this.templates = parsed.templates;
            } catch {
                this.configError = 'OA_TEMPLATES_INVALID';
                new Logger(WechatOaConfig.name).warn(this.configError);
            }
        }
        if ((this.sendEnabled || this.syncEnabled) && !this.credentialsReady()) {
            new Logger(WechatOaConfig.name).warn('OA_CONFIG_INVALID：服务号凭据缺失或仍为占位值');
        }
        if (this.sendEnabled) {
            const unavailable = Object.entries(this.templateReadiness()).filter(([, ready]) => !ready).map(([type]) => type);
            if (unavailable.length) new Logger(WechatOaConfig.name).warn(`OA_TEMPLATES_UNCONFIGURED types=${unavailable.join(',')}`);
        }
    }

    credentialsReady(): boolean {
        return /^wx[0-9a-f]{16}$/i.test(this.appId) && !isPlaceholder(this.secret);
    }

    assertApiEnabled(kind: 'sync' | 'send'): void {
        if (!(kind === 'sync' ? this.syncEnabled : this.sendEnabled)) throw new Error('OA_DISABLED');
        if (!this.credentialsReady()) throw new Error('OA_CONFIG_INVALID');
    }

    /** 仅返回类型与配置可用性，不暴露模板内容或凭据。 */
    templateReadiness(): Record<string, boolean> {
        return Object.fromEntries(OA_TEMPLATE_TYPES.map(type => [type, !!this.getTemplate(type)]));
    }

    getTemplate(type: string): OaTemplate | null {
        const template = this.templates[type];
        if (!template || isPlaceholder(template.templateId) || typeof template.fields !== 'object' || !template.fields) return null;
        const fields = Object.entries(template.fields);
        if (!fields.length || fields.length > 20 || fields.some(([key, field]) =>
            isPlaceholder(key) || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key) || !field
            || !OA_FIELD_SOURCES.includes(field.source) || !Number.isInteger(field.maxLength)
            || field.maxLength < 1 || field.maxLength > 500)) return null;
        return template;
    }
}
