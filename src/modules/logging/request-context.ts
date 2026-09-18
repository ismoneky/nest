import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';

/**
 * 请求上下文（requestId 关联）
 * 通过 AsyncLocalStorage 在请求生命周期内共享 requestId，
 * 业务代码记录日志时自动带上，保证同一请求的阶段日志使用同一个 requestId。
 */
export const requestContextStorage = new AsyncLocalStorage<{ requestId: string }>();

/**
 * 获取当前请求的 requestId（无请求上下文时生成新的，保证日志总有关联标识）
 */
export function getCurrentRequestId(): string {
    const store = requestContextStorage.getStore();
    return store?.requestId ?? `R${randomUUID().replace(/-/g, '').substring(0, 12)}`;
}

/**
 * Nest 中间件：为每个请求生成 requestId 并放入 AsyncLocalStorage
 */
export function requestIdMiddleware(req: any, _res: any, next: () => void) {
    const requestId = req.headers['x-request-id'] ?? `R${randomUUID().replace(/-/g, '').substring(0, 12)}`;
    requestContextStorage.run({ requestId }, () => next());
}
