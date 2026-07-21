import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Shared ioredis client for the game-flow state (rooms, players, games).
 * PostgreSQL never sees this data - see data-model.md, "Що живе в Redis".
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;

  private readonly logger = new Logger(RedisService.name);

  constructor(config: ConfigService) {
    this.client = new Redis({
      host: config.get<string>('REDIS_HOST', 'localhost'),
      port: config.get<number>('REDIS_PORT', 6379),
      password: config.get<string>('REDIS_PASSWORD') || undefined,
    });
    this.client.on('error', (err) => this.logger.error(err.message));
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }
}
