import { Body, CanActivate, Controller, ExecutionContext, ForbiddenException, HttpCode, Injectable, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService, type Identity } from './auth.service.js';
export type AuthRequest = Request & {identity: Identity};
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthRequest>();
    req.identity = await this.auth.authenticate(req.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1]);
    return true;
  }
}
@Injectable()
export class ProductWriteGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    if (!['seller','admin'].includes(context.switchToHttp().getRequest<AuthRequest>().identity.role)) throw new ForbiddenException('Seller or admin required');
    return true;
  }
}
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}
  @Post('login') @HttpCode(200)
  login(@Body() body: {email?:unknown;password?:unknown}) { return this.auth.login(body?.email,body?.password); }
  @Post('refresh') @HttpCode(200)
  refresh(@Body() body: {refresh_token?:unknown}) { return this.auth.refresh(body?.refresh_token); }
  @Post('logout') @HttpCode(204) @UseGuards(AuthGuard)
  async logout(@Req() req: AuthRequest) { await this.auth.logout(req.identity); }
}
