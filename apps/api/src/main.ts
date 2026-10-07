import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';

const IS_PROD = process.env.NODE_ENV === 'production';

async function bootstrap(): Promise<void> {
  // 生产环境禁止使用默认密钥/默认管理员密码启动（云服务器部署红线）
  if (IS_PROD) {
    if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'change-me-in-production') {
      throw new Error('生产环境必须设置 JWT_SECRET（随机长密钥），拒绝以默认密钥启动');
    }
    if (!process.env.SEED_ADMIN_PASSWORD || process.env.SEED_ADMIN_PASSWORD === 'Admin@123456') {
      throw new Error('生产环境必须设置 SEED_ADMIN_PASSWORD，拒绝以默认密码启动');
    }
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['log', 'warn', 'error'] });

  // nginx 反代后限流按真实客户端 IP 计数（否则所有请求同算代理 IP，限流失效/误伤）
  app.set('trust proxy', 1);

  app.enableCors({
    origin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
    credentials: true,
  });
  app.setGlobalPrefix('api');
  // 请求体校验统一走 ZodValidationPipe（src/common/zod.pipe.ts），不引入 class-validator

  // Swagger 仅非生产暴露，避免云服务器上泄露 API 面
  if (!IS_PROD) {
    const config = new DocumentBuilder()
      .setTitle('增强型智能家居 AI SaaS API')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, config));
  }

  const port = Number(process.env.PORT ?? 3080);
  await app.listen(port, '0.0.0.0');
  console.log(`api listening on http://localhost:${port}/api`);
}

void bootstrap();
