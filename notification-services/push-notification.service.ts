import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import * as admin from 'firebase-admin';
import { AuditHistoryRepository } from 'src/audit-history/repository/audit-history.repository';
import { Comment } from 'src/conversations/entities/comment.entity';
import { Post } from 'src/conversations/entities/post.entity';
import { UserDevicesRepository } from 'src/current-user/repositories/user-devices.repository';
import { UserRepository } from 'src/users/repositories/user.repository';
import { PushNotificationEnum } from '../enums/push-notification.enum';
import * as serviceAccountDev from '../mysterious-dev-570d9-519e5e6a4259.json';
import * as serviceAccount from '../mysterioussocial-ios-firebase-adminsdk-g9qd4-a82a12710b.json';
import {
  FirebaseNotificationChatroom,
  FirebaseNotificationPayload,
  makeNotificationPayloadForChatMessageReactionAddedNotification,
  makeNotificationPayloadForCommentCreated,
  makeNotificationPayloadForCommunityAnnouncement,
  makeNotificationPayloadForDirectMessage,
  makeNotificationPayloadForLeagueWeeklyResultsNotification,
  makeNotificationPayloadForPollVote,
  makeNotificationPayloadForPostCreated,
  makeNotificationPayloadForPostingTips,
  makeNotificationPayloadForReactionAdded,
  makeNotificationPayloadForReactionAddedOthers,
  makeNotificationPayloadForReminderNotification,
  makeNotificationPayloadForSelectedAsNextSpeakerByUser,
  makeNotificationPayloadForSelectedAsSpeaker,
  makeNotificationPayloadForTaggedInComment,
  makeNotificationPayloadForTaggedInPost,
  makeNotificationPayloadForUserRedeemdedInviteLinkNotification,
} from '../utils/push-notification.utils';

import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { MulticastMessage } from 'firebase-admin/lib/messaging/messaging-api';
import { ChatRoomRepository } from 'src/communities/repositories/chat_room.repository';
import { ChatRoomMappingRepository } from 'src/communities/repositories/chat_room_mapping.repository';
import { UserReaction } from 'src/conversations/entities/user-reactions.entity';
import { ChatMessage } from 'src/direct-messages/entities/chat-message.entity';
import { MicLevelEnum } from 'src/users/entities/mic-level.enum';
import { User } from 'src/users/entities/user.entity';
import { formatProfilePicture } from 'src/utils/utils';
import { NotificationSetting } from '../entities/notification-setting.entity';
import { PushNotification } from '../entities/push-notification.entity';
import { NotificationSettingRepository } from '../repository/notification-setting.repository';
import { PushNotificationRepository } from '../repository/push-notification.repository';

const SERVICE_ACCOUNT_DEV = serviceAccountDev as admin.ServiceAccount;
const SERVICE_ACCOUNT_PROD = serviceAccount as admin.ServiceAccount;

type PropsForMessage = {
  chatRoomId?: string | undefined;
  post?: Post | undefined;
  comment?: Comment | undefined;
  time?: string | undefined;
  user?: User | undefined; // usually the user who perform an action
  userReaction?: UserReaction | undefined;
  message?: ChatMessage | undefined;
  metadata?: any;
};

@Injectable()
export class PushNotificationService {
  private firebaseAdmin: admin.app.App;

  constructor(
    @InjectRepository(UserDevicesRepository)
    private readonly userDevicesRepository: UserDevicesRepository,

    @InjectRepository(UserRepository)
    private readonly userRepository: UserRepository,

    @InjectRepository(AuditHistoryRepository)
    private readonly auditHistoryRepository: AuditHistoryRepository,

    @InjectRepository(PushNotificationRepository)
    private readonly pushNotificationRepository: PushNotificationRepository,

    @InjectRepository(NotificationSettingRepository)
    private readonly notificationSettingRepository: NotificationSettingRepository,

    @InjectQueue('notification')
    private readonly notificationQueue: Queue,

    @InjectRepository(ChatRoomMappingRepository)
    private readonly chatRoomMappingRepository: ChatRoomMappingRepository,

    @InjectRepository(ChatRoomRepository)
    private readonly chatRoomRepository: ChatRoomRepository,
  ) {
    this.firebaseAdmin = admin.initializeApp(
      {
        credential: admin.credential.cert(
          process.env.env == 'dev' ? SERVICE_ACCOUNT_DEV : SERVICE_ACCOUNT_PROD,
        ),
      },
      'dev',
    );
  }

  // - Topic management

  public async addToTopicBackgroundProcessHandler(
    userId: string,
    chatRoomId: string,
  ): Promise<void> {
    await this.notificationQueue.add('add-to-topic', {
      userId,
      chatRoomId,
    });
  }

  public async removeFromTopicBackgroundProcessHandler(
    userId: string,
    chatRoomId: string,
  ): Promise<void> {
    await this.notificationQueue.add('remove-from-topic', {
      userId,
      chatRoomId,
    });
  }

  public async addToTopic(userId: string, chatRoomId: string): Promise<void> {
    const devices = await this.userDevicesRepository.findAllDevicesWithUserId(
      userId,
    );
    const tokens = devices.map((device) => device.deviceToken);
    if (!tokens.length) {
      return;
    }

    // Subscribe to topic
    try {
      const topic = this.makeTopic(chatRoomId);
      await this.firebaseAdmin.messaging().subscribeToTopic(tokens, topic);
    } catch (error) {
      console.log(error);
    }
  }

  public async removeUserFromTopic(
    userId: string,
    chatRoomId: string,
  ): Promise<void> {
    const devices = await this.userDevicesRepository.findActiveUserDevices(
      userId,
    );
    if (!devices.length) {
      return;
    }
    const tokens = devices.map((device) => device.deviceToken);
    if (tokens.length) {
      const topic = this.makeTopic(chatRoomId);
      await this.firebaseAdmin.messaging().unsubscribeFromTopic(tokens, topic);
    }
  }

  public async updateTopicForUserIds(userIds: string[]): Promise<void> {
    for (const userId of userIds) {
      await this.updateTopicForUserId(userId);
    }
  }

  public async updateTopicForUserId(userId: string): Promise<void> {
    const memberships =
      await this.chatRoomMappingRepository.getAllMappingWithUserId(userId);

    for (const membership of memberships) {
      if (
        [
          MicLevelEnum.VIEWER,
          MicLevelEnum.COMMENTATOR,
          MicLevelEnum.SPEAKER,
        ].includes(membership.micLevel)
      ) {
        await this.addToTopic(userId, membership.chatRoomId);
      } else {
        await this.removeUserFromTopic(userId, membership.chatRoomId);
      }
    }
  }

  public async removeDeviceTokensFromAllChatRooms(
    tokens: string[],
  ): Promise<void> {
    // DEBT: what happens when we have more than 100 communities?!
    const chatRooms = await this.chatRoomRepository.getAllChatRooms({
      limit: 100,
      page: 1,
    });

    for (const chatRoom of chatRooms) {
      const topic = this.makeTopic(chatRoom.id);
      await this.firebaseAdmin.messaging().unsubscribeFromTopic(tokens, topic);
    }
  }

  // - Notifications management

  /**
   * This is the prefered method to send notification to one or more users.
   * Notifications will be enqueued and processed in the background.
   */
  public async enqueueSendNotificationsForUsers(
    userIds: string[],
    type: PushNotificationEnum,
    props: PropsForMessage,
  ): Promise<void> {
    console.log(
      `...enqueuing push notification of type ${type} for users: ${userIds}`,
    );
    await this.notificationQueue.add('send-notification', {
      userIds,
      type,
      ...props,
    });
  }

  /**
   * Create and send the push notification to a list of users. This method
   * should only be called by the notification processor and must not be called
   * directly by other services.
   */
  public async createNotificationsForUsers(
    userIds: string[],
    type: PushNotificationEnum,
    otherProps: PropsForMessage,
  ) {
    for (const userId of userIds) {
      await this.sendNotificationToUser(userId, type, {
        ...otherProps,
      });
    }
  }

  // DEBT: Have the caller use `enqueueSendNotificationsForUsers` instead
  public async sendNotificationForSelectedAsNextSpeaker(
    creator: User,
    nextSpeakerUserId: string,
    time: string,
    chatRoomId: string,
  ): Promise<void> {
    await this.sendNotificationToUser(
      nextSpeakerUserId,
      PushNotificationEnum.SELECTED_AS_NEXT_SPEAKER,
      {
        chatRoomId,
        time,
        user: creator,
        comment: null,
        post: null,
        userReaction: null,
        message: null,
      },
    );
  }

  // DEBT: Have the caller use `enqueueSendNotificationsForUsers` instead
  public async sendNotificationsForReactionAdded(
    commentOwnerId: string,
    reactionAddedBy: User,
    chatRoomId: string,
    userReaction: UserReaction,
    comment: Comment,
  ) {
    // Send a notification to the owner of the comment
    await this.sendNotificationToUser(
      commentOwnerId,
      PushNotificationEnum.REACTION_ADDED,
      {
        chatRoomId,
        userReaction,
        user: reactionAddedBy,
        post: null,
        comment: null,
        time: null,
        message: null,
      },
    );

    // Send notification to everybody else
    if (userReaction.reaction.notificationSymbol) {
      const userIds = await this.retrieveUserListForReactionAddedOthers(
        chatRoomId,
        [reactionAddedBy.id, comment.userId],
      );
      await this.enqueueSendNotificationsForUsers(
        userIds,
        PushNotificationEnum.REACTION_ADDED_OTHERS,
        {
          chatRoomId,
          comment,
          userReaction,
          user: reactionAddedBy,
          message: null,
          post: null,
          time: null,
        },
      );
    }
  }

  // - User lists management

  private async retrieveUserListForReactionAddedOthers(
    chatRoomId: string,
    excludedUserIds: string[],
  ): Promise<string[]> {
    const entries =
      await this.notificationSettingRepository.findOptedInUsersForReactionAddedOthersNotifications(
        chatRoomId,
        excludedUserIds,
      );
    return entries.map((entry) => entry.userId);
  }

  async retrieveUserListForPostCreated(
    chatRoomId: string,
    excludedUserId: string,
  ): Promise<string[]> {
    const notificationSettingEntries =
      await this.notificationSettingRepository.findOptedInUsersForPostCreatedNotifications(
        chatRoomId,
        excludedUserId,
      );
    return notificationSettingEntries.map((entry) => entry.userId);
  }

  async retrieveUserListForCommentCreated(
    chatRoomId: string,
    excludedUserId: string,
  ): Promise<string[]> {
    const notificationSettingEntries =
      await this.notificationSettingRepository.findOptedInUsersForCommentCreatedNotifications(
        chatRoomId,
        excludedUserId,
      );
    return notificationSettingEntries.map((entry) => entry.userId);
  }

  // - Private

  private async sendNotificationToUser(
    userId: string,
    type: PushNotificationEnum,
    props: PropsForMessage,
  ) {
    // Check if user preferences should stop us from sending the notification
    // DEBT: this is going to be costly in term of performances, we don't really
    // need this check in theory if only user who opted in are added to the userIds
    const isAllowed = await this.validateAgainstUserPreferences(
      userId,
      type,
      props.chatRoomId,
    );
    if (!isAllowed) {
      console.error(
        `...notification will not be sent to user ${userId}, user opted out for ${type}`,
      );
      return;
    }

    // Generate message
    const message = await this.makeMessage(type, props);
    if (!message) {
      console.error(
        `...unsupported message type ${type}: failed to generate message payload.`,
      );
      return;
    }

    // Send the message to all active devices for this user
    const devices = await this.userDevicesRepository.findActiveUserDevices(
      userId,
    );
    if (!devices.length) {
      console.error(
        `...notification not sent to user ${userId}, no device found with a valid push token.`,
      );
      return;
    }
    const tokens = devices.map((device) => device.deviceToken);
    await this.sendMulticastMessage(tokens, message);

    // Log in the database for audit
    await this.addToNotificationHistory({
      userId,
      type,
      message,
    });
  }

  private async validateAgainstUserPreferences(
    userId: string,
    type: PushNotificationEnum,
    chatRoomId: string | undefined,
  ): Promise<boolean> {
    const user = await this.userRepository.findOneById(userId);

    let preferences: NotificationSetting | undefined;
    if (chatRoomId) {
      preferences = await this.notificationSettingRepository.findByUserId(
        userId,
        chatRoomId,
      );
    }

    switch (type) {
      case PushNotificationEnum.SELECTED_AS_SPEAKER:
        return true; // always send notifications when you are selected as speaker
      case PushNotificationEnum.POSTING_TIPS:
        return true; // always send notifications when you are selected as speaker
      case PushNotificationEnum.SELECTED_AS_NEXT_SPEAKER:
        return true; // always send notifications when you are selected as speaker by someone else
      case PushNotificationEnum.REMINDER_FOR_POST_CREATION:
        return true; // always send reminder notifications
      case PushNotificationEnum.USER_REDEEMED_INVITE_LINK:
        return true; // always send these notifications to admins
      case PushNotificationEnum.TAGGED_IN_COMMENT:
        return preferences?.taggedInComment ?? true;
      case PushNotificationEnum.TAGGED_IN_POST:
        return preferences?.taggedInPost ?? true;
      case PushNotificationEnum.ALL_COMMENTS:
        return preferences?.allComments ?? true;
      case PushNotificationEnum.POLL_VOTE:
        return preferences?.allComments ?? true; // Consider the votes as comments
      case PushNotificationEnum.POST_CREATED:
        return preferences?.postCreated ?? true;
      case PushNotificationEnum.REACTION_ADDED:
        return preferences?.reactionNotification ?? true;
      case PushNotificationEnum.REACTION_ADDED_OTHERS:
        return preferences?.reactionNotification ?? true;
      case PushNotificationEnum.COMMUNITY_ANNOUNCEMNT:
        return preferences?.communityAnnouncements ?? true;
      case PushNotificationEnum.DIRECT_MESSAGE:
        return user.directMessagesNotifications;
      case PushNotificationEnum.MESSAGE_REACTION_ADDED:
        return user.directMessagesNotifications;
      case PushNotificationEnum.LEAGUE_WEEKLY_RESULTS:
        return true;
      default:
        return true;
    }
  }

  private async sendMulticastMessage(
    deviceTokens: string[],
    payload: FirebaseNotificationPayload,
  ) {
    const message: MulticastMessage = {
      ...payload,
      tokens: deviceTokens,
    };
    try {
      const response = await this.firebaseAdmin
        .messaging()
        .sendMulticast(message);
      const invalidTokens = [];
      response.responses.forEach((element, index) => {
        if (
          element.success === false &&
          element?.error?.code &&
          [
            'messaging/mismatched-credential',
            'messaging/invalid-argument',
            'messaging/registration-token-not-registered',
          ].includes(element.error.code)
        ) {
          invalidTokens.push(deviceTokens[index]);
        }
      });
      if (invalidTokens.length > 0) {
        await this.userDevicesRepository.markDeviceTokensAsNull(invalidTokens);
      }
    } catch (error) {
      console.log(error.message);
    }
  }

  private async addToNotificationHistory(props: {
    message: any;
    userId: string;
    type: PushNotificationEnum;
  }): Promise<PushNotification> {
    const { message, userId, type } = props;
    return this.pushNotificationRepository.createPushNotificationLog({
      message: JSON.stringify(message),
      userId,
      notificationType: type,
    });
  }

  /**
   * Find chat room name and image to use for the name
   */
  private async makeChatRoomProps(
    chatRoomId: string,
  ): Promise<FirebaseNotificationChatroom> {
    const chatRoom = await this.chatRoomRepository.getChatRoomWithId(
      chatRoomId,
    );
    const image = chatRoom?.image ? formatProfilePicture(chatRoom.image) : '';
    const notificationImage = chatRoom.notificationImage
      ? formatProfilePicture(chatRoom.notificationImage)
      : '';
    return {
      id: chatRoomId,
      name: chatRoom.name,
      image: notificationImage || image || '',
    };
  }

  /**
   * Generate a topic name, a unique identifier representing all users
   * subscribed to messages for a given community.
   */
  private makeTopic(chatRoomId: string): string {
    // DEBT: what are these topic names? post-create-XXX does not sound right...
    const topic =
      process.env.env === 'dev' ? 'post-created-dev' : 'post-created-prod';
    return `${topic}__${chatRoomId}`;
  }

  /**
   * Generates a message ready to send to Firebase
   */
  private async makeMessage(
    type: PushNotificationEnum,
    otherProps: PropsForMessage,
  ): Promise<FirebaseNotificationPayload | null> {
    const { chatRoomId } = otherProps;

    // Generate chat room properties that will be used in most notifications
    let chatRoomProps: FirebaseNotificationChatroom | undefined;
    if (chatRoomId) {
      chatRoomProps = await this.makeChatRoomProps(chatRoomId);
    }

    switch (type) {
      case PushNotificationEnum.SELECTED_AS_SPEAKER:
        let userId = otherProps.user?.id;
        if (!userId) {
          // fallback on the speaker of the previous post
          const auditHistory =
            await this.auditHistoryRepository.findPreviousSpeaker(chatRoomId);
          userId = auditHistory[0].userId;
        }
        return makeNotificationPayloadForSelectedAsSpeaker(
          chatRoomProps,
          userId,
        );
      case PushNotificationEnum.POSTING_TIPS:
        return makeNotificationPayloadForPostingTips(chatRoomProps);
      case PushNotificationEnum.SELECTED_AS_NEXT_SPEAKER:
        return makeNotificationPayloadForSelectedAsNextSpeakerByUser(
          chatRoomProps,
          otherProps.user,
          otherProps.time,
        );
      case PushNotificationEnum.TAGGED_IN_COMMENT:
        return makeNotificationPayloadForTaggedInComment(
          chatRoomProps,
          otherProps.comment,
        );
      case PushNotificationEnum.TAGGED_IN_POST:
        return makeNotificationPayloadForTaggedInPost(
          chatRoomProps,
          otherProps.post,
        );
      case PushNotificationEnum.REMINDER_FOR_POST_CREATION:
        return makeNotificationPayloadForReminderNotification(
          chatRoomProps,
          otherProps.time,
        );
      case PushNotificationEnum.USER_REDEEMED_INVITE_LINK:
        return makeNotificationPayloadForUserRedeemdedInviteLinkNotification(
          chatRoomProps,
          otherProps.user,
        );
      case PushNotificationEnum.REACTION_ADDED:
        return makeNotificationPayloadForReactionAdded(
          chatRoomProps,
          otherProps.user,
          otherProps.userReaction,
        );
      case PushNotificationEnum.REACTION_ADDED_OTHERS:
        return makeNotificationPayloadForReactionAddedOthers(
          chatRoomProps,
          otherProps.user,
          otherProps.userReaction,
          otherProps.comment,
        );
      case PushNotificationEnum.POST_CREATED:
        return makeNotificationPayloadForPostCreated(
          chatRoomProps,
          otherProps.post,
        );
      case PushNotificationEnum.ALL_COMMENTS:
        return makeNotificationPayloadForCommentCreated(
          chatRoomProps,
          otherProps.comment,
        );
      case PushNotificationEnum.POLL_VOTE:
        return makeNotificationPayloadForPollVote(
          chatRoomProps,
          otherProps.user,
          otherProps.post,
        );
      case PushNotificationEnum.COMMUNITY_ANNOUNCEMNT:
        return makeNotificationPayloadForCommunityAnnouncement(
          chatRoomProps,
          otherProps.message,
        );
      case PushNotificationEnum.DIRECT_MESSAGE:
        return makeNotificationPayloadForDirectMessage(otherProps.message);
      case PushNotificationEnum.MESSAGE_REACTION_ADDED:
        return makeNotificationPayloadForChatMessageReactionAddedNotification(
          otherProps.user,
          otherProps.message,
        );
      case PushNotificationEnum.LEAGUE_WEEKLY_RESULTS:
        return makeNotificationPayloadForLeagueWeeklyResultsNotification(
          chatRoomProps,
          otherProps.metadata,
        );
      default:
        return null;
    }
  }
}
