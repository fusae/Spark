import cron from 'node-cron';
import type { ScheduledTask } from 'node-cron';
import { DatabaseManager } from '../db/index.js';
import { logger } from '../utils/logger.js';
import { RuntimeConfigRepository } from './config-repository.js';
import { RuntimeJobQueue } from './job-queue.js';

export class MultiUserScheduler {
  private tasks = new Map<string, ScheduledTask>();

  constructor(
    private db: DatabaseManager,
    private configRepository: RuntimeConfigRepository,
    private queue: RuntimeJobQueue
  ) {}

  reload(): void {
    this.stop();

    for (const user of this.db.listRuntimeUsers()) {
      const runtimeConfig = this.configRepository.get(user.user_id);
      if (!runtimeConfig) {
        continue;
      }

      const cronSchedule = runtimeConfig.schedule.cronSchedule;
      if (!cronSchedule || cronSchedule === 'manual') {
        logger.info(`Scheduler disabled for manual user: ${runtimeConfig.userId}`);
        continue;
      }

      if (!cron.validate(cronSchedule)) {
        logger.warn(`Invalid cron schedule for ${runtimeConfig.userId}: ${cronSchedule}`);
        continue;
      }

      const task = cron.schedule(
        cronSchedule,
        () => {
          this.queue.enqueue(runtimeConfig.userId, 'daily_run');
          logger.info(`Queued daily run: ${runtimeConfig.userId}`);
        },
        {
          timezone: runtimeConfig.schedule.timezone,
        }
      );
      this.tasks.set(runtimeConfig.userId, task);
    }

    logger.info(`Multi-user scheduler loaded ${this.tasks.size} user tasks`);
  }

  stop(): void {
    for (const task of this.tasks.values()) {
      task.stop();
    }
    this.tasks.clear();
  }

  getScheduledUserIds(): string[] {
    return Array.from(this.tasks.keys());
  }
}
