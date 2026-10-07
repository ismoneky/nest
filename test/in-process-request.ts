import { IncomingMessage, Server, ServerResponse } from 'http';
import { Duplex } from 'stream';
import FormData from 'form-data';

/** Exercise the actual Express/Nest request listener without opening any network port. */
export default function request(server: Server) {
    const make = (method: string, url: string) => {
        const headers: Record<string, string> = { host: 'localhost' };
        let body: Buffer = Buffer.alloc(0);
        let form: FormData | undefined;
        const run = () => new Promise<any>((resolve, reject) => {
            if (form) {
                Object.assign(headers, form.getHeaders());
                body = form.getBuffer();
            }
            headers['content-length'] = String(body.length);
            const transport = new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } });
            const req = new IncomingMessage(transport as any);
            req.method = method;
            req.url = url;
            req.headers = headers;
            const res = new ServerResponse(req);
            res.assignSocket(transport as any);
            const chunks: Buffer[] = [];
            const write = res.write.bind(res);
            const end = res.end.bind(res);
            res.write = ((chunk: any, ...args: any[]) => {
                if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                return write(chunk, ...args);
            }) as any;
            res.end = ((chunk: any, ...args: any[]) => {
                if (chunk && typeof chunk !== 'function') chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                return end(chunk, ...args);
            }) as any;
            const timeout = setTimeout(() => reject(new Error(`${method} ${url} did not finish`)), 5000);
            res.on('finish', () => {
                clearTimeout(timeout);
                const raw = Buffer.concat(chunks);
                const responseHeaders = res.getHeaders();
                const value = String(responseHeaders['content-type'] || '').includes('application/json') ? JSON.parse(raw.toString()) : raw;
                resolve({ status: res.statusCode, body: value, headers: responseHeaders });
                transport.destroy();
            });
            res.on('error', reject);
            server.emit('request', req, res);
            req.push(body);
            // A real HTTP parser sets this after the complete body arrives. Without it,
            // IncomingMessage treats end-of-stream as aborted and closes async responses.
            req.complete = true;
            req.push(null);
        });
        return {
            set(key: string, value: string) { headers[key.toLowerCase()] = value; return this; },
            send(value: unknown) { headers['content-type'] = 'application/json'; body = Buffer.from(JSON.stringify(value)); return this; },
            attach(key: string, buffer: Buffer, options: string | { filename: string; contentType: string }) {
                form ||= new FormData();
                form.append(key, buffer, options);
                return this;
            },
            async expect(status: number) {
                const result = await run();
                expect(result.status).toBe(status);
                return result;
            },
            then(resolve: (value: any) => any, reject?: (reason: unknown) => any) { return run().then(resolve, reject); },
        };
    };
    return { get: (url: string) => make('GET', url), put: (url: string) => make('PUT', url), post: (url: string) => make('POST', url) };
}
