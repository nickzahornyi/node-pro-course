import { Body, Controller, Headers, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, type AuthRequest } from '../auth/http.js';
import { FilesService } from './service.js';
@Controller('uploads') @UseGuards(AuthGuard)
export class FilesController {
  constructor(private readonly files: FilesService) {}
  @Post('intent') @HttpCode(200)
  intent(@Req() req:AuthRequest,@Headers('idempotency-key') key:string,@Body() body:unknown) { return this.files.intent(req.identity.userId,key,body); }
  @Post('resume') @HttpCode(200)
  resume(@Req() req:AuthRequest,@Body() body:{id:string}) { return this.files.resume(req.identity.userId,body?.id); }
  @Post('commit') @HttpCode(200)
  commit(@Req() req:AuthRequest,@Body() body:{id:string}) { return this.files.commit(req.identity.userId,body?.id); }
}
