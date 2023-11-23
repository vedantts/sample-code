import { Injectable } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ChatRoom } from 'src/communities/entities/chat_room.entity';
import { ChatRoomMapping } from 'src/communities/entities/chat_room_mapping.entity';
import { ChatRoomRepository } from 'src/communities/repositories/chat_room.repository';
import { ChatRoomMappingRepository } from 'src/communities/repositories/chat_room_mapping.repository';
import { LeagueRepository } from 'src/contests/repositories/league.repository';
import { PostRepository } from 'src/conversations/repositories/post.repository';
import {
  EmailService,
  makeReminderEmailContent,
} from 'src/email/services/email.service';
import {
  calculateDifferenceInTimeOut,
  convertEndingAtToString,
} from 'src/utils/utils';
import { PushNotificationEnum } from '../enums/push-notification.enum';
import { PushNotificationService } from './push-notification.service';

enum REMINDER_TIMERS {
  TWELVE_HOURS = 43200000,
  SIX_HOURS = 21600000,
  ONE_HOUR = 3600000,
}

@Injectable()
export class ReminderNotificationService {
  constructor(
    private readonly postRepository: PostRepository,
    private readonly chatRoomRepository: ChatRoomRepository,
    private readonly chatRoomMappingRepository: ChatRoomMappingRepository,
    private readonly pushNotificationService: PushNotificationService,
    private schedulerRegistry: SchedulerRegistry,
    private readonly emailService: EmailService,
    private readonly leagueRepository: LeagueRepository,
  ) {}

  name = 'reminder';
  reminderGreaterThanLimit = 'reminder-timer-greater-than-limit';
  maxTimeoutLimit = +1296000000;

  async adjustTimer(chatRoomId) {
    const speaker = await this.checkIfSpeaker(chatRoomId);
    if (speaker) {
      const ms = calculateDifferenceInTimeOut(speaker.endingAt);
      if (ms >= REMINDER_TIMERS.TWELVE_HOURS) {
        this.sendPushNotificationIfSpeakerIsStillActive(
          chatRoomId,
          ms - REMINDER_TIMERS.TWELVE_HOURS,
        );
      } else if (ms >= REMINDER_TIMERS.SIX_HOURS) {
        this.sendPushNotificationIfSpeakerIsStillActive(
          chatRoomId,
          ms - REMINDER_TIMERS.SIX_HOURS,
        );
      } else if (ms >= REMINDER_TIMERS.ONE_HOUR) {
        this.sendPushNotificationIfSpeakerIsStillActive(
          chatRoomId,
          ms - REMINDER_TIMERS.ONE_HOUR,
        );
      }
    }
  }

  private async sendPushNotificationIfSpeakerIsStillActive(
    chatRoomId,
    timer: number,
  ) {
    this.deleteTimeout(chatRoomId);
    this.deleteTimeoutsGreaterThanLimit(chatRoomId);
    if (timer > this.maxTimeoutLimit) {
      this.addTimerGreaterThanLimit(chatRoomId);
      return;
    }
    const livePostAvailable = await this.checkIfLivePost(chatRoomId);
    if (livePostAvailable) {
      return;
    }
    const speaker = await this.checkIfSpeaker(chatRoomId);
    if (!speaker) {
      return;
    }

    const sendPushNotificationAfterTimeExecution =
      this.sendPushNotificationAfterTime.bind(this);
    const name = this.name + '__' + chatRoomId;
    this.deleteTimeout(chatRoomId);
    this.deleteTimeoutsGreaterThanLimit(chatRoomId);
    console.log(
      `adding notification reminder after ${timer} for chat room - ${chatRoomId}`,
    );
    this.scheduleTimeout(
      name,
      () => {
        sendPushNotificationAfterTimeExecution(chatRoomId);
      },
      timer,
    );
  }

  private async sendPushNotificationAfterTime(chatRoomId) {
    const livePostAvailable = await this.checkIfLivePost(chatRoomId);
    if (livePostAvailable) {
      return;
    }
    const speaker = await this.checkIfSpeaker(chatRoomId);
    if (!speaker) {
      return;
    }
    await this.sendNotifications(chatRoomId, speaker);
    this.adjustTimer(chatRoomId);
  }

  private async sendNotifications(
    chatRoomId: string,
    speaker: ChatRoomMapping,
  ): Promise<void> {
    const community = await this.chatRoomRepository.getChatRoomWithId(
      chatRoomId,
    );
    const formattedTime = convertEndingAtToString(speaker.endingAt);
    await this.pushNotificationService.enqueueSendNotificationsForUsers(
      [speaker.userId],
      PushNotificationEnum.REMINDER_FOR_POST_CREATION,
      {
        chatRoomId,
        time: formattedTime,
        comment: undefined,
        post: undefined,
        user: undefined,
        userReaction: undefined,
        message: undefined,
      },
    );

    const activeLeagues =
      await this.leagueRepository.findActiveLeaguesForCommunity(chatRoomId);
    const includeTips = activeLeagues.length > 0;

    await this.sendReminderEmail(
      formattedTime,
      speaker,
      community,
      includeTips,
    );
  }

  private async checkIfLivePost(chatRoomId) {
    const livePost = await this.postRepository.getLivePost(chatRoomId);
    if (livePost.length) {
      return true;
    }
    return false;
  }

  private async checkIfSpeaker(chatRoomId) {
    const speaker = await this.chatRoomMappingRepository.findUserWithMic(
      chatRoomId,
    );
    return speaker;
  }

  private getTimeouts(chatRoomId) {
    const timeouts = this.schedulerRegistry.getTimeouts();
    const name = this.name + '__' + chatRoomId;
    const timeout = timeouts.find((key) => key === name);
    return { name, timeout };
  }

  async deleteTimeout(chatRoomId: string) {
    try {
      const { name, timeout } = this.getTimeouts(chatRoomId);

      if (timeout) {
        this.schedulerRegistry.deleteTimeout(name);
      }
    } catch (error) {
      console.log(error.message);
    }
  }

  private async sendReminderEmail(
    time: string,
    speaker: ChatRoomMapping,
    community: ChatRoom,
    includeTips: boolean,
  ) {
    try {
      const user = speaker.user;
      const currentSpeakerName =
        user.firstName ?? user.username ?? user.email ?? user.publicAddress;
      const communityName = community.name;
      const { emailTemplate, plainText, title } = makeReminderEmailContent(
        time,
        currentSpeakerName,
        communityName,
        includeTips,
        this.emailService.makeUnsubscribeLink(user.id),
      );
      if (speaker.user.email && speaker.user.emailOptIn) {
        await this.emailService.sendEmail({
          emailTemplate,
          plainText,
          user: speaker.user,
          title,
        });
      }
    } catch (error) {
      console.log(error);
    }
  }

  private getTimeoutsGreaterThanLimit(chatRoomId) {
    const timeouts = this.schedulerRegistry.getTimeouts();
    const name = this.reminderGreaterThanLimit + '__' + chatRoomId;
    const timeout = timeouts.find((key) => key === name);
    return { name, timeout };
  }

  private async deleteTimeoutsGreaterThanLimit(chatRoomId) {
    try {
      const { name, timeout } = this.getTimeoutsGreaterThanLimit(chatRoomId);

      if (timeout) {
        this.schedulerRegistry.deleteTimeout(name);
      }
    } catch (error) {
      console.log(error.message);
    }
  }

  private async addTimerGreaterThanLimit(chatRoomId) {
    this.deleteTimeout(chatRoomId);
    this.deleteTimeoutsGreaterThanLimit(chatRoomId);

    const adjustTimerBindedWithThis = this.adjustTimer.bind(this);
    const name = this.reminderGreaterThanLimit + '__' + chatRoomId;
    console.log(
      `adding notification reminder after ${this.maxTimeoutLimit} for chat room - ${chatRoomId}`,
    );
    this.scheduleTimeout(
      name,
      () => {
        adjustTimerBindedWithThis(chatRoomId);
      },
      this.maxTimeoutLimit,
    );
  }

  private scheduleTimeout(name: string, callback: () => void, ms?: number) {
    if (process.env.DISABLE_TIMERS) {
      console.log(
        `[DISABLE_TIMERS] ignoring request to schedule a timeout for ${name}`,
      );
      return;
    }
    const timeoutId = setTimeout(callback, ms);
    this.schedulerRegistry.addTimeout(name, timeoutId);
  }
}
