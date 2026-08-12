// 必须在所有其他代码之前设置，扩大 libuv 线程池（默认 4），避免 DNS 解析等阻塞操作打满线程池导致事件循环卡死
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '16';

import * as dotenv from 'dotenv';
dotenv.config();

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { json } from 'express';
import * as crypto from 'crypto';

// Polyfill global.crypto for Node.js < 19
if (!global.crypto) {
  (global as any).crypto = crypto;
}

import { AppModule } from './app.module';

async function bootstrap() {
  // NestJS 10 的 NestApplicationOptions.bodyParser 只接受 boolean，没有 rawBody 选项（v11 才有）。
  // 这里关闭内置 bodyParser，手动挂 express json()，并通过 verify 回调缓存原始请求体字节，
  // 供微信支付回调验签使用（JSON 重新序列化会改变字段顺序导致验签失败）。
  // 请求体上限 192 KiB（logging-design.md「批量上报」默认 100kb 不够）。
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.use(json({
    limit: '192kb',
    verify: (req: any, _res, buf: Buffer) => {
      if (buf) {
        req.rawBody = buf;
      }
    },
  }));

  // 启用全局验证管道,防止无效数据导致内存问题
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: false,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // 启用 CORS
  const corsOrigin = process.env.CORS_ORIGIN || '*';
  app.enableCors({
    origin: corsOrigin === '*' ? '*' : corsOrigin.split(',').map(o => o.trim()),
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: 'Content-Type, Accept, Authorization, x-admin-key',
    credentials: corsOrigin !== '*',
  });

  const port = process.env.PORT || '3000';
  await app.listen(port, '0.0.0.0');

}
bootstrap();
