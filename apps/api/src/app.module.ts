import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule } from './prisma/prisma.module.js';
import { AdminModule } from './admin/admin.module.js';
import { HealthModule } from './health/health.module.js';
import { BrandingModule } from './branding/branding.module.js';
import { AuthModule } from './auth/auth.module.js';
import { RbacModule } from './rbac/rbac.module.js';
import { BillingModule } from './billing/billing.module.js';
import { TenantsModule } from './tenants/tenants.module.js';
import { ContentModule } from './content/content.module.js';
import { LlmModule } from './llm/llm.module.js';
import { MediaModule } from './media/media.module.js';
import { PlansModule } from './plans/plans.module.js';
import { OrdersModule } from './orders/orders.module.js';
import { KnowledgeModule } from './knowledge/knowledge.module.js';
import { LayoutModule } from './layout/layout.module.js';
import { AgentsModule } from './agents/agents.module.js';
import { FeedbackModule } from './feedback/feedback.module.js';
import { LightingModule } from './lighting/lighting.module.js';
import { CanvasModule } from './canvas/canvas.module.js';
import { AgentModule } from './agent/agent.module.js';
import { TeamModule } from './team/team.module.js';
import { BenchmarkModule } from './benchmark/benchmark.module.js';
import { DesktopModule } from './desktop/desktop.module.js';
import { AuditInterceptor } from './agent/audit.interceptor.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../../.env'] }),
    // 限流 env 可配（自部署单机默认放宽；云服务器按需收紧）
    ThrottlerModule.forRoot([
      {
        limit: Number(process.env.RATE_LIMIT_GLOBAL ?? 300),
        ttl: 60_000,
      },
    ]),
    PrismaModule,
    AdminModule,
    HealthModule,
    BrandingModule,
    AuthModule,
    RbacModule,
    BillingModule,
    TenantsModule,
    ContentModule,
    LlmModule,
    MediaModule,
    PlansModule,
    OrdersModule,
    KnowledgeModule,
    LayoutModule,
    AgentsModule,
    FeedbackModule,
    LightingModule,
    CanvasModule,
    // 0.1.53：机器接入（API Key / 能力清单 / 快照还原）+ 全量审计
    AgentModule,
    // 0.1.54：团队成员与角色模板
    TeamModule,
    // 对标账号情报：配置对标账号 → 采集热门内容元数据 → AI 映射学习比对
    BenchmarkModule,
    // 桌面端设置：仅桌面单机版可用（非桌面端部署端点直接 404）
    DesktopModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // 全量审计：靠它兜住「以后新增的 service 又忘了写审计」这件事，逐个 service 手写是补不齐的
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule {}
