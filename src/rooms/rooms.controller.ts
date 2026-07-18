import {
  Body,
  Controller,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { JwtPayload } from '../auth/jwt-payload';
import { RoomCreateDto, RoomSettingsDto } from './dto/room-create.dto';
import { RoomCreated, RoomPublicInfo, RoomsService } from './rooms.service';

@Controller('rooms')
export class RoomsController {
  constructor(private readonly roomsService: RoomsService) {}

  /** POST /rooms → 201 RoomCreated | 401 | 404 (foreign bank) | 409 (not enough ready sets). */
  @UseGuards(JwtAuthGuard)
  @Post()
  create(
    @CurrentUser() payload: JwtPayload,
    @Body() body: RoomCreateDto,
  ): Promise<RoomCreated> {
    return this.roomsService.createRoom(payload.sub, body);
  }

  /** PATCH /rooms/{roomId} → 200 RoomPublicInfo | 401 | 404 (foreign) | 409 (not waiting). */
  @UseGuards(JwtAuthGuard)
  @Patch(':roomId')
  updateSettings(
    @CurrentUser() payload: JwtPayload,
    @Param('roomId') roomId: string,
    @Body() body: RoomSettingsDto,
  ): Promise<RoomPublicInfo> {
    return this.roomsService.updateSettings(payload.sub, roomId, body);
  }
}
