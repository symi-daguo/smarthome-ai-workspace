import { Body, Controller, Get, Patch, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { AuthService, type AuthProfile } from './auth.service.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { changePasswordSchema, loginSchema, registerSchema, updateProfileSchema, type ChangePasswordDto, type LoginDto, type RegisterDto, type UpdateProfileDto } from './auth.schemas.js';
import { CurrentUser } from './current-user.decorator.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  // 注册/登录防暴力破解：单 IP 每分钟上限 env 可配（默认 10，云服务器可收紧）
  @Throttle({ default: { limit: Number(process.env.RATE_LIMIT_AUTH ?? 10), ttl: 60_000 } })
  @Post('register')
  register(@Body(new ZodValidationPipe(registerSchema)) dto: RegisterDto): Promise<{
    token: string;
    user: AuthProfile;
  }> {
    return this.auth.register(dto);
  }

  @Throttle({ default: { limit: Number(process.env.RATE_LIMIT_AUTH ?? 10), ttl: 60_000 } })
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

  /** 刷新 JWT（携带有效旧 token 换新 token，延长有效期避免过期丢会话） */
  @UseGuards(AuthGuard('jwt'))
  @Post('refresh')
  refresh(@CurrentUser() user: AuthProfile): Promise<{ token: string; user: AuthProfile }> {
    return this.auth.refresh(user.id);
  }

  @UseGuards(AuthGuard('jwt'))
  @Post('change-password')
  changePassword(
    @CurrentUser() user: AuthProfile,
    @Body(new ZodValidationPipe(changePasswordSchema)) dto: ChangePasswordDto,
  ): Promise<{ ok: true }> {
    return this.auth.changePassword(user.id, dto);
  }

  @UseGuards(AuthGuard('jwt'))
  @Patch('profile')
  updateProfile(
    @CurrentUser() user: AuthProfile,
    @Body(new ZodValidationPipe(updateProfileSchema)) dto: UpdateProfileDto,
  ): Promise<AuthProfile> {
    return this.auth.updateProfile(user.id, dto);
  }
}
