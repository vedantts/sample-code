import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { PushNotificationService } from '../services/push-notification.service';

@Processor('notification')
export class NotificationProcessor {
  private readonly logger = new Logger(NotificationProcessor.name);

  constructor(
    private readonly pushNotificationService: PushNotificationService,
  ) {}
  @Process('send-notification')
  async backgroundTask(job: Job) {
    this.logger.debug('send notification queue started');
    const { userIds, type } = job.data;
    await this.pushNotificationService.createNotificationsForUsers(
      userIds,
      type,
      {
        ...job.data,
      },
    );
    this.logger.debug('send notification queue completed...');
  }

  @Process('add-to-topic')
  async backgroundTaskForAddingToTopic(job: Job) {
    const { chatRoomId, userId } = job.data;
    this.logger.debug(
      `add to topic background process started for user id - ${userId} for chat room - ${chatRoomId} started`,
    );
    await this.pushNotificationService.addToTopic(
      job.data.userId,
      job.data.chatRoomId,
    );
    this.logger.debug(
      `add to topic background process started for user id - ${userId} for chat room - ${chatRoomId} ended`,
    );
  }

  @Process('remove-from-topic')
  async backgroundTaskForRemovingToTopic(job: Job) {
    const { chatRoomId, userId } = job.data;
    this.logger.debug(
      `remove from topic background process started for user id - ${userId} for chat room - ${chatRoomId} started`,
    );
    await this.pushNotificationService.removeUserFromTopic(
      job.data.userId,
      job.data.chatRoomId,
    );
    this.logger.debug(
      `remove from topic background process started for user id - ${userId} for chat room - ${chatRoomId} ended`,
    );
  }
}
