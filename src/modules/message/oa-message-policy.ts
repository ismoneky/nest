import { Message, MessageType, OaSendStatus } from '../../entities/message.entity';
import { WechatOaConfig, isPlaceholder } from '../wechat-oa/wechat-oa.config';
import { OaPayload } from '../wechat-oa/wechat-oa.types';
import { beijingDateStr } from '../../common/date-utils';
import { renderMessage } from './message-templates';

export type OaMessageFields = Pick<Message, 'oaSendStatus' | 'oaPayloadJson' | 'oaNextAttemptAt' | 'oaExpiresAt' | 'oaSkipReason'>;
export interface OaSnapshot { version: 1; oaAppId: string; payload: OaPayload }
const STATUS: Partial<Record<MessageType, string>> = {
    ORDER_EXPIRE_REMINDER: '订单即将过期', ORDER_EXPIRED: '订单已过期，可申请退款', REFUND_ACCEPTED: '退款申请已受理',
    REFUND_APPROVED: '退款审核通过', REFUND_REJECTED: '退款审核未通过', REFUND_SUCCESS: '退款已到账',
};

export function skippedOa(reason: string): OaMessageFields {
    return { oaSendStatus: OaSendStatus.SKIPPED, oaPayloadJson: null, oaNextAttemptAt: null, oaExpiresAt: null, oaSkipReason: reason };
}

/** 同一条 INSERT 保存渠道快照；模板失败不能妨碍站内信入库。 */
export function prepareOaMessage(type: MessageType, ctx: Parameters<typeof renderMessage>[1], config: WechatOaConfig, now: number): OaMessageFields {
    if (!config.sendEnabled) return skippedOa('DISABLED');
    if (!STATUS[type]) return skippedOa('UNSUPPORTED_TYPE');
    if (!config.credentialsReady() || !/^wx[0-9a-f]{16}$/i.test(config.miniAppId)) return skippedOa('CONFIG_INVALID');
    if (config.configError) return skippedOa(config.configError);
    try {
        const template = config.getTemplate(type);
        if (!template) return skippedOa('TEMPLATE_UNCONFIGURED');
        const eventTime = new Date(now + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
        const values: Record<string, string> = { bookingId: ctx.bookingId || '', bizNo: ctx.bizNo || '',
            refundAmount: Number.isSafeInteger(ctx.refundAmount) && ctx.refundAmount >= 0 ? (ctx.refundAmount / 100).toFixed(2) : '',
            rejectReason: ctx.rejectReason || '', applyDeadline: ctx.applyDeadline || '', eventTime, status: STATUS[type] };
        const data: OaPayload['data'] = {};
        for (const [key, field] of Object.entries(template.fields)) {
            const value = values[field.source];
            if (!value || [...value].length > field.maxLength) return skippedOa('TEMPLATE_DATA_INVALID');
            data[key] = { value };
        }
        let expiresAt = now + 24 * 3600000;
        if (type === MessageType.ORDER_EXPIRE_REMINDER) expiresAt = endOfBeijingDate(beijingDateStr(new Date(now)));
        if (type === MessageType.ORDER_EXPIRED && ctx.applyDeadline) expiresAt = endOfBeijingDate(ctx.applyDeadline);
        if (!Number.isFinite(expiresAt)) return skippedOa('EXPIRY_INVALID');
        if (expiresAt <= now) return skippedOa('EXPIRED');
        const snapshot: OaSnapshot = { version: 1, oaAppId: config.appId, payload: { template_id: template.templateId,
            miniprogram: { appid: config.miniAppId, pagepath: 'pages/index/index' }, data } };
        return { oaSendStatus: OaSendStatus.PENDING, oaPayloadJson: JSON.stringify(snapshot), oaNextAttemptAt: now,
            oaExpiresAt: expiresAt, oaSkipReason: null };
    } catch { return skippedOa('TEMPLATE_DATA_INVALID'); }
}

function endOfBeijingDate(date: string): number {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NaN;
    const start = Date.parse(`${date}T00:00:00+08:00`);
    if (!Number.isFinite(start) || beijingDateStr(new Date(start)) !== date) return NaN;
    return start + 24 * 3600000;
}

export function parseOaSnapshot(json: string | null, config: WechatOaConfig): OaPayload | null {
    try {
        const s = JSON.parse(json || 'null') as OaSnapshot;
        if (s?.version !== 1 || s.oaAppId !== config.appId || isPlaceholder(s.payload?.template_id)
            || s.payload.miniprogram?.appid !== config.miniAppId || s.payload.miniprogram?.pagepath !== 'pages/index/index') return null;
        const data = s.payload.data;
        if (!data || typeof data !== 'object' || Array.isArray(data) || !Object.keys(data).length
            || Object.entries(data).some(([key, field]) => isPlaceholder(key) || typeof field?.value !== 'string' || !field.value)) return null;
        // 只取允许的字段，持久化 JSON 中不能带 touser/token/url 等覆盖接收人或凭据。
        return { template_id: s.payload.template_id, miniprogram: s.payload.miniprogram, data };
    } catch { return null; }
}
