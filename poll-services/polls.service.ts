import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ChatRoomMappingRepository } from 'src/communities/repositories/chat_room_mapping.repository';
import { ChatRoomGateway } from 'src/communities/services/chat_room.gateway';
import { ScoreboardActivityType } from 'src/contests/entities/scoreboard-ledger-entry.entity';
import { ContestsService } from 'src/contests/services/contests.service';
import { PostContentType } from 'src/conversations/entities/post-content.entity';
import { Post } from 'src/conversations/entities/post.entity';
import { PostRepository } from 'src/conversations/repositories/post.repository';
import { PushNotificationEnum } from 'src/push-notification/enums/push-notification.enum';
import { PushNotificationService } from 'src/push-notification/services/push-notification.service';
import { MicLevelEnum } from 'src/users/entities/mic-level.enum';
import { User } from 'src/users/entities/user.entity';
import { UserRepository } from 'src/users/repositories/user.repository';
import { PollChoice } from '../entities/poll-choice.entity';
import { PollVote } from '../entities/poll-vote.entity';
import { PollWithChoices } from '../entities/poll.entity';
import { PollChoiceRepository } from '../repositories/poll-choice.repository';
import { PollVoteRepository } from '../repositories/poll-vote.repository';
import { PollRepository } from '../repositories/poll.repository';

@Injectable()
export class PollsService {
  constructor(
    private readonly chatRoomGateway: ChatRoomGateway,
    private readonly chatRoomMappingRepository: ChatRoomMappingRepository,
    private readonly contestsService: ContestsService,
    private readonly pollRepository: PollRepository,
    private readonly pollChoiceRepository: PollChoiceRepository,
    private readonly pollVoteRepository: PollVoteRepository,
    private readonly postRepository: PostRepository,
    private readonly pushNotificationService: PushNotificationService,
    private readonly userRepository: UserRepository,
  ) {}

  async createPoll(
    communityId: string,
    userId: string | null,
    props: {
      title: string;
      anonymous: boolean;
      choices: { text: string }[];
    },
  ): Promise<PollWithChoices> {
    // Create an empty poll
    const createdPoll = await this.pollRepository.createPoll(
      communityId,
      userId,
      props.title,
      props.anonymous,
    );

    // Add choices
    let index = 0;
    for (const choice of props.choices) {
      await this.pollChoiceRepository.createChoice(
        createdPoll.id,
        choice.text,
        index++,
      );
    }

    // Return full poll with choices
    return this.getPoll(createdPoll.id, communityId);
  }

  async getPoll(pollId: string, communityId: string): Promise<PollWithChoices> {
    const poll = await this.pollRepository.getPollWithChoices(pollId);
    if (!poll) {
      throw new NotFoundException();
    }
    if (poll.chatRoomId !== communityId) {
      throw new ForbiddenException();
    }
    return poll;
  }

  async updatePoll(
    pollId: string,
    communityId: string,
    currentUser: User,
    props: {
      title: string;
      anonymous: boolean;
    },
  ): Promise<PollWithChoices> {
    const livePost = await this.validateThatPollIsAttachedToLivePost(
      pollId,
      communityId,
      currentUser,
    );

    const preUpdatePoll = await this.getPoll(pollId, communityId);
    await this.pollRepository.updatePoll(
      preUpdatePoll,
      props.title,
      props.anonymous,
    );

    // Notify connected users via web socket
    const updatedPoll = await this.getPoll(pollId, communityId);
    await this.chatRoomGateway.emitPostPollUpdated(
      communityId,
      livePost.conversationId,
      updatedPoll,
    );

    return updatedPoll;
  }

  async addChoiceToPoll(
    pollId: string,
    communityId: string,
    currentUser: User,
    props: {
      text: string;
      rank: number;
    },
  ): Promise<PollChoice> {
    const livePost = await this.validateThatPollIsAttachedToLivePost(
      pollId,
      communityId,
      currentUser,
    );

    const addedChoice = await this.pollChoiceRepository.createChoice(
      pollId,
      props.text,
      props.rank,
    );

    // Notify connected users via web socket
    const poll = await this.getPoll(pollId, communityId);
    await this.chatRoomGateway.emitPostPollUpdated(
      communityId,
      livePost.conversationId,
      poll,
    );

    return addedChoice;
  }

  async updatePollChoice(
    choiceId: string,
    pollId: string,
    communityId: string,
    currentUser: User,
    props: {
      text: string;
      rank: number;
    },
  ): Promise<PollChoice> {
    const livePost = await this.validateThatPollIsAttachedToLivePost(
      pollId,
      communityId,
      currentUser,
    );

    const choice = await this.pollChoiceRepository.getChoiceById(choiceId);
    const updatedChoice = await this.pollChoiceRepository.updateChoice(
      choice,
      props.text,
      props.rank,
    );

    // Notify connected users via web socket
    const poll = await this.getPoll(pollId, communityId);
    await this.chatRoomGateway.emitPostPollUpdated(
      communityId,
      livePost.conversationId,
      poll,
    );

    return updatedChoice;
  }

  async deleteChoice(
    choiceId: string,
    pollId: string,
    communityId: string,
    currentUser: User,
  ): Promise<void> {
    const livePost = await this.validateThatPollIsAttachedToLivePost(
      pollId,
      communityId,
      currentUser,
    );

    await this.pollVoteRepository.softDeleteBasedOnChoice(choiceId);
    await this.pollChoiceRepository.softDelete(choiceId);

    // Notify connected users via web socket
    const poll = await this.getPoll(pollId, communityId);
    await this.chatRoomGateway.emitPostPollUpdated(
      communityId,
      livePost.conversationId,
      poll,
    );
  }

  async castVote(
    choiceId: string,
    pollId: string,
    communityId: string,
    userId: string,
  ): Promise<void> {
    const livePost = await this.validateThatPollIsAttachedToLivePost(
      pollId,
      communityId,
      null,
    );

    // Validate that user is authorized to vote
    const member = await this.chatRoomMappingRepository.findMappingWithUserId(
      communityId,
      userId,
    );
    if (
      !member ||
      ![MicLevelEnum.COMMENTATOR, MicLevelEnum.SPEAKER].includes(
        member.micLevel,
      ) ||
      member.incognito
    ) {
      throw new ForbiddenException(
        'Only members of the community with full-access can vote.',
      );
    }

    // If user already voted, replace their vote with the new one
    const existingVotes = await this.pollVoteRepository.findVotes(
      pollId,
      userId,
    );
    if (existingVotes.length) {
      for (const existingVote of existingVotes) {
        await this.pollVoteRepository.softDelete(existingVote.id);
        const previousChoice = await this.pollChoiceRepository.getChoiceById(
          existingVote.choiceId,
        );
        await this.pollChoiceRepository.decrementVotes(previousChoice);
      }
    }

    // Register the vote
    await this.pollVoteRepository.createVote(choiceId, pollId, userId);

    // Increment number of voters on the choice
    const newChoice = await this.pollChoiceRepository.getChoiceById(choiceId);
    await this.pollChoiceRepository.incrementVotes(newChoice);

    // Notify users via push notification & web socket
    const poll = await this.getPoll(pollId, communityId);
    const userIds =
      await this.pushNotificationService.retrieveUserListForCommentCreated(
        communityId,
        userId,
      );
    const user = await this.userRepository.findOneById(userId);
    await this.pushNotificationService.enqueueSendNotificationsForUsers(
      userIds,
      PushNotificationEnum.POLL_VOTE,
      {
        chatRoomId: communityId,
        user,
        comment: null,
        message: null,
        post: livePost,
        time: null,
        userReaction: null,
      },
    );
    await this.chatRoomGateway.emitPostPollUpdated(
      communityId,
      livePost.conversationId,
      poll,
    );

    await this.contestsService.recordEntry(
      communityId,
      userId,
      ScoreboardActivityType.POLL_VOTED,
      `POLL_VOTE_REGISTERED_${pollId}_${userId}`,
      0.3,
      1,
    );
  }

  async fetchVoters(
    choiceId: string,
    pollId: string,
    communityId: string,
    filters: {
      page?: number;
      limit?: number;
    },
  ): Promise<{
    voters: User[];
    count: number;
  }> {
    const poll = await this.getPoll(pollId, communityId);
    if (poll.anonymous) {
      throw new ForbiddenException();
    }

    const { page = 1, limit = 25 } = filters;
    const skip = limit * (page - 1);
    const { votes, count } = await this.pollVoteRepository.findVoters(
      choiceId,
      pollId,
      skip,
      limit,
    );

    return {
      voters: votes.map((vote) => vote.user),
      count,
    };
  }

  async retrieveVote(pollId: string, userId: string): Promise<PollVote | null> {
    return this.pollVoteRepository.findVote(pollId, userId);
  }

  async hasVoted(
    pollId: string,
    choiceId: string,
    userId: string,
  ): Promise<boolean> {
    const vote = await this.pollVoteRepository.findVote(pollId, userId);
    return vote && vote.choiceId === choiceId;
  }

  async deletePollAndVotes(pollId: string): Promise<void> {
    await this.pollVoteRepository.hardDeleteAllVotes(pollId);
    await this.pollChoiceRepository.hardDeleteAllChoices(pollId);
    await this.pollRepository.hardDeletePoll(pollId);
  }

  private async validateThatPollIsAttachedToLivePost(
    pollId: string,
    communityId: string,
    currentUser?: User,
  ): Promise<Post> {
    const livePosts = await this.postRepository.getLivePost(communityId);
    if (!livePosts.length) {
      throw new ForbiddenException(
        'This poll is not associated with a currently live post.',
      );
    }
    const livePost = livePosts[0];
    const filteredPostContents = livePost.postContents.filter(
      (postContent) =>
        postContent.contentType === PostContentType.POLL &&
        postContent.content === pollId,
    );
    if (!filteredPostContents.length) {
      throw new ForbiddenException(
        'This poll is not associated with a currently live post.',
      );
    }

    if (currentUser && livePost.userId !== currentUser.id) {
      throw new ForbiddenException('Only the post author can modify a poll');
    }

    return livePost;
  }
}
