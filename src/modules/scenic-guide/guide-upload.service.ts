import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash, createHmac, randomUUID } from 'crypto';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const EXTENSIONS: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

@Injectable()
export class GuideUploadService {
    /** COS POST policy; the browser sends file bytes directly to COS, never to this API.
     * Protocol: https://cloud.tencent.com/document/product/436/9067
     */
    createPolicy(input: unknown) {
        const data = input as { contentType?: unknown; size?: unknown } | null;
        const contentType = data?.contentType;
        const size = data?.size;
        if (typeof contentType !== 'string' || !Object.hasOwn(EXTENSIONS, contentType) || typeof size !== 'number' || !Number.isInteger(size) || size <= 0 || size > MAX_IMAGE_BYTES) {
            throw new BadRequestException('请选择不超过10 MB的 JPG、PNG 或 WebP 图片');
        }
        const { COS_BUCKET: bucket, COS_REGION: region, COS_SECRET_ID: secretId, COS_SECRET_KEY: secretKey, COS_PUBLIC_BASE_URL: baseUrl } = process.env;
        if (!bucket || !/^[a-z0-9-]+-\d+$/.test(bucket) || !region || !/^[a-z]+-[a-z]+(?:-\d+)?$/.test(region) || !secretId || !secretKey || !baseUrl) {
            throw new ServiceUnavailableException('腾讯云 COS 上传尚未配置，请联系管理员配置，或先填写已有的 HTTPS 图片链接');
        }
        let publicBase: URL;
        try { publicBase = new URL(baseUrl); } catch { throw new ServiceUnavailableException('COS 图片访问域名配置不正确'); }
        if (publicBase.protocol !== 'https:' || publicBase.search || publicBase.hash || publicBase.username || publicBase.password) throw new ServiceUnavailableException('COS 图片访问域名须为不带参数的 HTTPS 地址');

        const key = `scenic-guide/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.${EXTENSIONS[contentType]}`;
        const start = Math.floor(Date.now() / 1000);
        const expires = start + 600;
        const time = `${start};${expires}`;
        const policy = JSON.stringify({
            expiration: new Date(expires * 1000).toISOString(),
            conditions: [
                { bucket }, { key }, { 'Content-Type': contentType },
                ['content-length-range', 1, size],
                { 'q-sign-algorithm': 'sha1' }, { 'q-ak': secretId }, { 'q-sign-time': time },
                { success_action_status: '204' },
            ],
        });
        const signingKey = createHmac('sha1', secretKey).update(time).digest('hex');
        const policyHash = createHash('sha1').update(policy).digest('hex');
        const signature = createHmac('sha1', signingKey).update(policyHash).digest('hex');
        return {
            uploadUrl: `https://${bucket}.cos.${region}.myqcloud.com`,
            imageUrl: `${baseUrl.replace(/\/+$/, '')}/${key}`,
            expiresAt: expires * 1000,
            fields: {
                key, 'Content-Type': contentType, success_action_status: '204',
                policy: Buffer.from(policy).toString('base64'),
                'q-sign-algorithm': 'sha1', 'q-ak': secretId, 'q-key-time': time, 'q-signature': signature,
            },
        };
    }
}
