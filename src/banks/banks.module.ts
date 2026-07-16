import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BanksController } from './banks.controller';
import { BanksService } from './banks.service';

@Module({
  imports: [AuthModule],
  controllers: [BanksController],
  providers: [BanksService],
})
export class BanksModule {}
