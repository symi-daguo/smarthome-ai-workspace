import { Controller, Get, Module } from '@nestjs/common';

@Controller('health')
class HealthController {
  @Get()
  check(): { status: string; uptime: number; timestamp: string } {
    return { status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() };
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
