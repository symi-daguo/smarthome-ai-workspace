import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { AuthService, type AuthProfile } from './auth.service.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { changePasswordSchema, loginSchema, registerSchema, type ChangePasswordDto, type LoginDto, type RegisterDto } from './auth.schemas.js';
import { CurrentUser } from './current-user.decorator.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  // 注册/登录防暴力破解：单 IP 每分钟最多 10 次（远低于全局 120，覆盖撞库）
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('register')
  register(@Body(new ZodValidationPipe(registerSchema)) dto: RegisterDto): Promise<{
    token: string;
    user: AuthProfile;
  }> {
    return this.auth.register(dto);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  login(@Body(new ZodValidationPipe(loginSchema)) dto: LoginDto): Promise<{
    token: string;
    user: AuthProfile;
  }> {
    return this.auth.login(dto);
  }

  @UseGuards(AuthGuard('jwt'))
  @Get('me')
  me(@CurrentUser() user: AuthProfile): AuthProfile {
    return user;
  }

  @UseGuards(AuthGuard('jwt'))
  @Post('change-password')
  changePassword(
    @CurrentUser() user: AuthProfile,
    @Body(new ZodValidationPipe(changePasswordSchema)) dto: ChangePasswordDto,
  ): Promise<{ ok: true }> {
    return this.auth.changePassword(user.id, dto);
  }
}
