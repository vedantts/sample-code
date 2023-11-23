import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ChatRoomMappingRepository } from 'src/communities/repositories/chat_room_mapping.repository';
import { ChatRoomGateway } from 'src/communities/services/chat_room.gateway';
import { DailyCountRepository } from 'src/daily-count/repository/daily-count.repository';
import { getFormattedDate } from 'src/utils/utils';
import { NotificationSetting } from '../entities/notification-setting.entity';
import { NotificationSettingRepository } from '../repository/notification-setting.repository';

@Injectable()
export class NotificationSettingService {
  constructor(
    @InjectRepository(NotificationSettingRepository)
    private readonly notificationSettingRepository: NotificationSettingRepository,

    private readonly chatRoomGateway: ChatRoomGateway,

    @InjectRepository(DailyCountRepository)
    private readonly dailyCountRepository: DailyCountRepository,

    @InjectRepository(ChatRoomMappingRepository)
    private readonly chatRoomMappingRepository: ChatRoomMappingRepository,
  ) {}

  /**
   * Retrieve user preferences for a given community. Every user have a set of preferences
   * that are unique to a community they belong to.
   *
   * Side effect:
   * - potentially updates the database with a new set of preferences
   */
  async getUserCommunityPreferences(
    userId: string,
    communityId: string,
  ): Promise<NotificationSetting> {
    // Retrieve
    const preferences = await this.notificationSettingRepository.findByUserId(
      userId,
      communityId,
    );

    // Use case: create new notification settings if they don't exist already as they were not created
    // with the user.
    //
    // DEBT: we should ensure notification settings are created alongside the user and that all users
    // have settings.
    if (!preferences) {
      return this.notificationSettingRepository.add({
        userId,
        chatRoomId: communityId,
      });
    }

    return preferences;
  }

  /**
   * Update user preferences for a given community. Every user have a set of preferences
   * that are unique to a community they belong to.
   *
   * Side effects:
   * - update the database
   * - potentially notifies client using the websocket
   */
  async updateUserCommunityPreferences(
    userId: string,
    communityId: string,
    settings: {
      taggedInPost?: boolean;
      taggedInComment?: boolean;
      postCreated?: boolean;
      selectedAsSpeaker?: boolean;
      selectedAsNextSpeaker?: boolean;
      allComments?: boolean;
      showInViewedBy?: boolean;
      reactionNotification?: boolean;
      communityAnnouncements?: boolean;
    },
  ): Promise<NotificationSetting> {
    const notificationSettings = await this.getUserCommunityPreferences(
      userId,
      communityId,
    );

    // With this flag, we will attempt to detect changes that requires notifying the clients
    const previousShowInViewedBy = notificationSettings.showInViewedBy;

    // Update settings
    if (settings.taggedInPost !== undefined) {
      notificationSettings.taggedInPost = settings.taggedInPost;
    }
    if (settings.taggedInComment !== undefined) {
      notificationSettings.taggedInComment = settings.taggedInComment;
    }
    if (settings.postCreated !== undefined) {
      notificationSettings.postCreated = settings.postCreated;
    }
    if (settings.selectedAsSpeaker !== undefined) {
      notificationSettings.selectedAsSpeaker = settings.selectedAsSpeaker;
    }
    if (settings.selectedAsNextSpeaker !== undefined) {
      notificationSettings.selectedAsNextSpeaker =
        settings.selectedAsNextSpeaker;
    }
    if (settings.allComments !== undefined) {
      notificationSettings.allComments = settings.allComments;
    }
    if (settings.reactionNotification !== undefined) {
      notificationSettings.reactionNotification = settings.reactionNotification;
    }
    if (settings.communityAnnouncements !== undefined) {
      notificationSettings.communityAnnouncements =
        settings.communityAnnouncements;
    }
    if (settings.showInViewedBy !== undefined) {
      notificationSettings.showInViewedBy = settings.showInViewedBy;
    }
    const updatedPreferences = await this.notificationSettingRepository.save(
      notificationSettings,
    );

    // Notify client if they need to re-fetch data
    if (
      settings.showInViewedBy !== undefined &&
      previousShowInViewedBy !== settings.showInViewedBy
    ) {
      await this.chatRoomGateway.emitPostViewsUpdatedAfterToggle(communityId);
    }

    return updatedPreferences;
  }

  async getNotificationSettingsGraphsData(chatRoomId, startDate, endDate) {
    if (!chatRoomId || !startDate || !endDate) {
      throw new HttpException(
        'ChatRoomId, startDate, endDate is required',
        HttpStatus.FORBIDDEN,
      );
    }

    const currentFullAccessCount =
      await this.chatRoomMappingRepository.getCountOfCommentators(chatRoomId);

    const dailyCountObject =
      await this.dailyCountRepository.getMiclevelCountBasedOnChatRoom(
        chatRoomId,
        startDate,
        endDate,
      );

    const formattedData = [];
    for (
      let i = new Date(startDate).getTime();
      i <= new Date(endDate).getTime();
      i = i + 86400000
    ) {
      const countObj = dailyCountObject.find(
        (el) => el.date === getFormattedDate(new Date(i)),
      );
      formattedData.push({
        date: getFormattedDate(new Date(i)),
        fullAccessCount:
          countObj?.commentatorcount ?? currentFullAccessCount ?? '0',
        allComments: countObj?.allCommentsCount ?? '0',
        mentions: countObj?.mentions ?? '0',
        newPosts: countObj?.postCreatedCount ?? '0',
      });
    }

    return formattedData;
  }

  async createNotificationSettingsIfNotPresent(
    userId: string,
    chatRoomId: string,
  ): Promise<void> {
    try {
      const notificationSettings =
        await this.notificationSettingRepository.findByUserId(
          userId,
          chatRoomId,
        );
      if (!notificationSettings) {
        await this.notificationSettingRepository.add({
          userId: userId,
          chatRoomId: chatRoomId,
        });
      }
    } catch (error) {
      console.log(error);
    }
  }
}
