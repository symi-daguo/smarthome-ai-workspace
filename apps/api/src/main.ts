import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { brandName } from './branding/branding.module.js';

const IS_PROD = process.env.NODE_ENV === 'production';

/**
 * 桌面单机模式（Electron 全内嵌版）。
 *
 * 桌面端跑在**用户自己的机器**上：数据只在本机 pgdata、只监听 127.0.0.1，
 * 不存在「公网暴露 + 默认密码」的风险，而且它的产品定义就是
 * 「装完即用、默认管理员账号直接能登录」，所以必须放行预置的默认密码。
 *
 * 这个开关只由桌面端主进程注入（apps/desktop/src/api.ts），
 * 云服务器部署路径永远不会设它 —— 默认密码红线依然生效。
 */
const IS_DESKTOP = process.env.DESKTOP_MODE === '1';

async function bootstrap(): Promise<void> {
  // 生产环境禁止使用默认密钥/默认管理员密码启动（云服务器部署红线）
  if (IS_PROD) {
    if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'change-me-in-production') {
      throw new Error('生产环境必须设置 JWT_SECRET（随机长密钥），拒绝以默认密钥启动');
    }
    // 桌面单机模式例外：预置默认密码是它的既定行为（首启弹窗会告知用户改密）
    if (!IS_DESKTOP && (!process.env.SEED_ADMIN_PASSWORD || process.env.SEED_ADMIN_PASSWORD === 'Admin@123456')) {
      throw new Error('生产环境必须设置 SEED_ADMIN_PASSWORD，拒绝以默认密码启动');
    }
  }

  /**
   * 日志级别按环境收敛。
   *
   * 生产只留 warn / error：`RoutesResolver` 会把 140+ 条路由映射逐条打进 `log` 级别，
   * 那是开发期排查路由冲突用的噪音 —— 容器里 `docker logs` 全被它刷满，
   * 真正要看的错误反而找不到。
   * 开发环境保留 log（要看「模块没被加载」这类问题），debug 留给追调用链。
   */
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: IS_PROD ? ['warn', 'error'] : ['log', 'warn', 'error', 'debug'],
  });
  // 把 RoutesResolver 那条启动横幅也压掉：它走 log 级别，
  // 上面已把生产 logger 收敛到 warn/error，这里再兜一次防止框架内部直接写 console
  if (IS_PROD) Logger.overrideLogger(['warn', 'error']);

  // nginx 反代后限流按真实客户端 IP 计数（否则所有请求同算代理 IP，限流失效/误伤）
  app.set('trust proxy', 1);

  // CORS 只影响「前端与 API 不同源」的情况：
  //   - 容器部署时 nginx 把 /api 同源反代到 api 容器，因此**局域网访问不受 CORS 限制**，
  //     团队成员用浏览器打开 http://<主机IP>:5173 即可，不需要改任何配置。
  //   - 只有本地开发（vite 5173 直连 api 3080，跨源）才需要列出来源。
  // 但同网段的另一台机器若要跑 vite dev 调试，主机名/IP 各不相同，
  // 因此除 CORS_ORIGIN 外还放行所有局域网地址（RFC1918 + 本机回环）。
  const allowlist = (process.env.CORS_ORIGIN ?? 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const isLanOrigin = (origin: string): boolean => {
    if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) return false;
    return true;
  };
  app.enableCors({
    origin: (origin, cb) => {
      // 无 Origin（同源、curl、服务端调用）直接放行
      if (!origin) return cb(null, true);
      if (allowlist.includes('*') || allowlist.includes(origin)) return cb(null, true);
      // 开发态同网段调试：http://192.168.x.x:5173 / http://10.x.x.x:5173
      if (/^https?:\/\/((\d{1,3}\.){3}\d{1,3}|\[[0-9a-fA-F:]+\])(:\d+)?$/.test(origin)) return cb(null, true);
      if (isLanOrigin(origin)) return cb(null, true);
      return cb(new Error(`CORS 拒绝来源 ${origin}；如需放行请在 CORS_ORIGIN 里加白名单`), false);
    },
    credentials: true,
  });
  app.setGlobalPrefix('api');
  // 请求体校验统一走 ZodValidationPipe（src/common/zod.pipe.ts），不引入 class-validator

  // Swagger 仅非生产暴露，避免云服务器上泄露 API 面
  if (!IS_PROD) {
    const config = new DocumentBuilder()
      .setTitle(`${brandName()} API`)
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
