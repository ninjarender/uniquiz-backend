import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { JwtPayload } from '../auth/jwt-payload';
import { GenerationJobView, GenerationService } from './generation.service';

@UseGuards(JwtAuthGuard)
@Controller('banks/:bankId/generation')
export class GenerationController {
  constructor(private readonly generationService: GenerationService) {}

  /** POST /banks/{bankId}/generation → 202 GenerationJob | 401 | 404 | 409. */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  start(
    @CurrentUser() payload: JwtPayload,
    @Param('bankId', ParseUUIDPipe) bankId: string,
  ): Promise<GenerationJobView> {
    return this.generationService.startGeneration(payload.sub, bankId);
  }
}
