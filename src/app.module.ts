import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AnswerSetsModule } from './answer-sets/answer-sets.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { BanksModule } from './banks/banks.module';
import { ImagesModule } from './images/images.module';
import { GenerationModule } from './generation/generation.module';
import { QuestionsModule } from './questions/questions.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { RoomsModule } from './rooms/rooms.module';
import { GameModule } from './game/game.module';
import { ResultsModule } from './results/results.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('REDIS_HOST', 'localhost'),
          port: config.get<number>('REDIS_PORT', 6379),
          password: config.get<string>('REDIS_PASSWORD') || undefined,
        },
      }),
    }),
    PrismaModule,
    RedisModule,
    AuthModule,
    BanksModule,
    ImagesModule,
    QuestionsModule,
    GenerationModule,
    AnswerSetsModule,
    RoomsModule,
    GameModule,
    ResultsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
