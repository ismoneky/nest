/**
 * 日志敏感字段过滤与体积限制（服务端写库前的最终防线，不信任客户端过滤结果）。
 *
 * 规则（logging-design.md「敏感信息与滥用防护」）：
 * - 递归最多 5 层；超过深度替换为 "[MaxDepth]"，循环引用替换为 "[Circular]"
 * - 每个对象最多保留 50 个键，每个数组最多保留 50 项，字符串最多 2,000 个字符
 * - 超出键/数组/字符串限制时截断并置 truncated=true
 * - 最终 contextJson 最多 8 KiB（超限时逐轮截短最长字符串，仍超则只保留截断标记）
 * - 过滤字段名：authorization / token / password / secret / key（含常见变体）/
 *   idCard / phone / openid / wechatOpenId
 */

const MAX_DEPTH = 5;
const MAX_OBJECT_KEYS = 50;
const MAX_ARRAY_ITEMS = 50;
const MAX_STRING_LENGTH = 2000;
const MAX_CONTEXT_BYTES = 8 * 1024;

/**
 * 敏感键名判定：小写键名包含敏感词，或匹配 key 的常见变体
 * （key 用变体正则避免误伤 keyword / bookingKey 等普通键）
 */
const SENSITIVE_KEY_PATTERNS = ['authorization', 'token', 'password', 'secret', 'idcard', 'phone', 'openid', 'wechatopenid'];
const KEY_VARIANT_REGEX = /^(key|(api|app|private|public|merchant|secret|access|pay)[_-]?key)$/;

function isSensitiveKey(key: string): boolean {
    const lower = key.toLowerCase();
    if (SENSITIVE_KEY_PATTERNS.some((p) => lower.includes(p))) {
        return true;
    }
    return KEY_VARIANT_REGEX.test(lower);
}

export interface FilteredContext {
    /** 过滤并截断后的 JSON（contextJson 字段） */
    json: string;
    /** 是否发生过任何截断/过滤 */
    truncated: boolean;
}

/**
 * 递归过滤上下文
 */
export function filterContext(context: unknown): FilteredContext {
    const seen = new WeakSet<object>();
    let truncated = false;

    const sanitize = (value: unknown, depth: number): unknown => {
        if (value === null || value === undefined) {
            return null;
        }
        if (typeof value === 'string') {
            return truncateString(value, (t) => {
                truncated = t;
            });
        }
        if (typeof value === 'number' || typeof value === 'boolean') {
            return value;
        }
        if (depth > MAX_DEPTH) {
            return '[MaxDepth]';
        }
        if (typeof value === 'object') {
            if (seen.has(value)) {
                return '[Circular]';
            }
            seen.add(value);
            try {
                if (Array.isArray(value)) {
                    const items = value.slice(0, MAX_ARRAY_ITEMS);
                    if (value.length > MAX_ARRAY_ITEMS) {
                        truncated = true;
                    }
                    return items.map((item) => sanitize(item, depth + 1));
                }
                const result: Record<string, unknown> = {};
                let kept = 0;
                for (const [key, val] of Object.entries(value)) {
                    if (isSensitiveKey(key)) {
                        truncated = true;
                        continue; // 敏感字段直接丢弃
                    }
                    if (kept >= MAX_OBJECT_KEYS) {
                        truncated = true;
                        break;
                    }
                    result[key] = sanitize(val, depth + 1);
                    kept++;
                }
                return result;
            } finally {
                seen.delete(value);
            }
        }
        // 函数/符号等不可序列化值
        truncated = true;
        return null;
    };

    const sanitized = sanitize(context, 0);

    // 8 KiB 总量限制：逐轮截短最长字符串，最多 3 轮
    let json = JSON.stringify(sanitized);
    for (let round = 0; round < 3 && json.length > MAX_CONTEXT_BYTES; round++) {
        const shortened = shortenLongestString(sanitized, MAX_CONTEXT_BYTES / 2);
        truncated = true;
        json = JSON.stringify(shortened);
    }
    if (json.length > MAX_CONTEXT_BYTES) {
        truncated = true;
        json = JSON.stringify({ contextTooLarge: true });
    }

    return { json, truncated };

    function truncateString(s: string, onTruncate: (t: boolean) => void): string {
        if (s.length <= MAX_STRING_LENGTH) {
            return s;
        }
        onTruncate(true);
        return s.substring(0, MAX_STRING_LENGTH);
    }

    /**
     * 把对象中最长的字符串值截短一半（用于 8 KiB 总量压缩）
     */
    function shortenLongestString(value: unknown, targetLength: number): unknown {
        if (typeof value === 'string') {
            return value.length > targetLength ? value.substring(0, targetLength) : value;
        }
        if (Array.isArray(value)) {
            return value.map((item) => shortenLongestString(item, targetLength));
        }
        if (value !== null && typeof value === 'object') {
            const result: Record<string, unknown> = {};
            for (const [key, val] of Object.entries(value)) {
                result[key] = shortenLongestString(val, targetLength);
            }
            return result;
        }
        return value;
    }
}

/**
 * 过滤请求/响应头字段（完整请求头禁止写入日志）
 */
export function filterHeaders(headers: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(headers ?? {})) {
        if (isSensitiveKey(key)) {
            continue;
        }
        result[key] = value;
    }
    return result;
}
