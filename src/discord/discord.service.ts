import { Injectable } from '@nestjs/common';
import * as Discord from 'discord.js';
import { token, serverId, channelIds } from '../../config.json';
import * as dayjs from 'dayjs';
import * as duration from 'dayjs/plugin/duration';
import 'dayjs/plugin/timezone';
import 'dayjs/plugin/utc';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { LogEntry, LogEntrySchema } from './schema/log-entry.schema';
import { LogLeave, LogLeaveSchema } from './schema/log-leave.schema';
import { UserTotalTime, UserTotalTimeSchema } from './schema/user-total-tiem.schema';
import { convertUtcToBangkok } from './timezome/convert-time-to-bangkok';

dayjs.extend(duration);
dayjs.extend(require('dayjs/plugin/timezone'));
dayjs.extend(require('dayjs/plugin/utc'));

@Injectable()
export class DiscordService {
  private readonly client: Discord.Client;
  private userTimeMap: Map<string, { joinTime: string }> = new Map();
  private totalTimes: Map<string, number> = new Map();

  constructor(
    @InjectModel(LogEntry.name) private readonly logEntryModel: Model<LogEntry>,
    @InjectModel(LogLeave.name) private readonly logLeaveModel: Model<LogLeave>,
    @InjectModel(UserTotalTime.name) private readonly userTotalTimeModel: Model<UserTotalTime>
  ) {
    this.client = new Discord.Client({
      intents: [
        Discord.GatewayIntentBits.GuildMessages,
        Discord.GatewayIntentBits.GuildMembers,
        Discord.GatewayIntentBits.DirectMessages,
        Discord.GatewayIntentBits.MessageContent,
        Discord.GatewayIntentBits.Guilds,
        Discord.GatewayIntentBits.GuildVoiceStates,
      ],
      partials: [
        Discord.Partials.Message,
        Discord.Partials.Channel,
        Discord.Partials.GuildMember,
        Discord.Partials.User,
        Discord.Partials.GuildScheduledEvent,
        Discord.Partials.ThreadMember,
      ],
    });

    this.client.once('ready', (client) => {
      console.log('Bot ' + client.user.tag + ' is now online!');
    });

    this.client.login(token);

    this.setupEventHandlers();
  }
  private async setupEventHandlers() {
    this.client.on('voiceStateUpdate', async (oldState, newState) => {
      try {
        const guild = await newState.guild.members.fetch(newState.member.user.id);
        const updatedState = {
          ...newState,
          member: guild,
        };

        if (updatedState.channelId && updatedState.guild.id === serverId && updatedState.channelId === channelIds.voiceChannel) {
          const entry = {
            username: updatedState.member.user.username,
            userId: updatedState.member.id,
            action: 'join',
            timestamp: dayjs().tz('Asia/Bangkok').format(),
          };

          await this.logEntry(updatedState, entry);
        }

        if (oldState.channelId === channelIds.voiceChannel && !newState.channelId) {
          const entry = {
            username: oldState.member.user.username,
            userId: oldState.member.id,
            action: 'leave',
            timestamp: dayjs().tz('Asia/Bangkok').format(),
          };

          await this.logLeave(oldState, entry);
        }

      } catch (error) {
        console.error('Error handling voiceStateUpdate event:', error);
      }
    });
  }

  private async logEntry(newState, entry) {
    try {
      const logEntry = new this.logEntryModel({
        ...entry,
        timestamp: dayjs(entry.timestamp).tz('Asia/Bangkok').toDate(),
      });
  
      await logEntry.save();
      console.log('User join event saved to MongoDB:', logEntry);
  
      const message = `User ${entry.username} joined the voice channel at ${logEntry.timestamp}`;
      this.sendLogMessage(channelIds.channelenter, message);
  
      this.userTimeMap.set(entry.userId, { joinTime: entry.timestamp });
    } catch (error) {
      console.error('Error logging entry:', error.message);
    }
  }
  
  private async logLeave(oldState, entry) {
    try {
      const logLeave = new this.logLeaveModel({
        ...entry,
        timestamp: dayjs(entry.timestamp).tz('Asia/Bangkok').toDate(),
      });
  
      await logLeave.save();
      console.log('User leave event saved to MongoDB:', logLeave);
  
      const message = `User ${entry.username} left the voice channel at ${logLeave.timestamp}`;
      this.sendLogMessage(channelIds.channelleave, message);
  
      this.handleUserTotalTime(oldState, entry);
  
      this.userTimeMap.delete(entry.userId);
    } catch (error) {
      console.error('Error logging leave entry:', error.message);
    }
  }

  private async handleUserTotalTime(oldState, entry) {
    try {
      if (this.userTimeMap.has(entry.userId)) {
        const joinTime = dayjs(this.userTimeMap.get(entry.userId).joinTime);
        const leaveTime = dayjs(entry.timestamp);
        const duration = dayjs.duration(leaveTime.diff(joinTime));
  
        if (this.totalTimes.has(entry.userId)) {
          const totalTime = this.totalTimes.get(entry.userId);
          this.totalTimes.set(entry.userId, totalTime + duration.asMinutes());
        } else {
          this.totalTimes.set(entry.userId, duration.asMinutes());
        }
  
        await this.saveTotalTime(entry.userId, entry.username, this.totalTimes.get(entry.userId));
        this.sendTotalTimeMessage(oldState, entry);
      }
    } catch (error) {
      console.error('Error handling user total time:', error.message);
    }
  }

  private async saveTotalTime(userId: string, discordName: string, totalTime: number) {
    try {
      const bangkokTime = dayjs().tz('Asia/Bangkok').format();
      const hours = Math.floor(totalTime / 60);
      const minutes = Math.floor(totalTime % 60);
      const seconds = Math.round((totalTime % 1) * 60);
      const existingRecord = await this.userTotalTimeModel.findOne({
        discordId: userId,
        createdAt: {
          $gte: dayjs(bangkokTime).startOf('day').toDate(),
          $lt: dayjs(bangkokTime).endOf('day').toDate(),
        },
      });
  
      if (existingRecord) {
        existingRecord.totalTime = {
          hours: hours.toString(),
          minutes: minutes.toString(),
          seconds: seconds.toString(),
        };
        await existingRecord.save();
        console.log(`Total time for User ${discordName} on ${bangkokTime} updated to ${hours} hours, ${minutes} minutes, ${seconds} seconds`);
      } else {
        const totalTimeEntry = new this.userTotalTimeModel({
          discordName,
          discordId: userId,
          totalTime: {
            hours: hours.toString(),
            minutes: minutes.toString(),
            seconds: seconds.toString(),
          },
          createdAt: dayjs(bangkokTime).toDate(),
        });
        await totalTimeEntry.save();
        console.log(`Total time for User ${discordName} on ${bangkokTime} saved: ${hours} hours, ${minutes} minutes, ${seconds} seconds`);
      }
    } catch (error) {
      console.error('Error saving total time entry:', error.message);
    }
  }

  private sendLogMessage(channelId: string, message: string) {
    const channel = this.client.guilds.cache.get(serverId).channels.cache.get(channelId) as Discord.TextChannel;
    if (channel) {
      channel.send(`\`\`\`${message}\`\`\``);
    }
  }
  

  private async sendTotalTimeMessage(oldState, entry) {
    try {
      if (channelIds.channeltotaltime) {
        const totalTimeInMinutes = this.totalTimes.get(entry.userId);
        const hours = Math.floor(totalTimeInMinutes / 60);
        const minutes = Math.floor(totalTimeInMinutes % 60);
        const seconds = Math.round((totalTimeInMinutes % 1) * 60);
  
        const totalChannel = oldState.guild.channels.cache.get(channelIds.channeltotaltime) as Discord.TextChannel;
        if (totalChannel) {
          const totalTimeMessage = `\`\`\`User ${entry.username} spent a total of ${hours} hours, ${minutes} minutes, ${seconds} seconds in the voice channel.\`\`\``;
          totalChannel.send(totalTimeMessage);
        } else {
          console.error(`Error: Channel with ID ${channelIds.channeltotaltime} not found.`);
        }
      }
    } catch (error) {
      console.error('Error sending total time message:', error.message);
    }
  }
}