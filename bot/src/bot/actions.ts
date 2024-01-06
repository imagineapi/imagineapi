import invariant from "tiny-invariant";
import dotenvSafe from "dotenv-safe";

dotenvSafe.config();

import { logger } from "../utils/logger";

type ChannelType2 = { id: string; name: string; type: number };

async function createChannel(
  token: string,
  guildId: string,
  channelName: string,
  channelType: number
): Promise<ChannelType2> {
  const body = JSON.stringify({
    name: channelName,
    type: channelType,
  });

  const headers = {
    "Content-Type": "application/json",
    Authorization: token,
  };

  const response = await fetch(
    `https://discord.com/api/v9/guilds/${guildId}/channels`,
    {
      method: "POST",
      headers,
      body,
    }
  );

  if (!response.ok) {
    logger.error(`Error creating channel: ${response.statusText}`);
    throw new Error(`Error creating channel: ${response.statusText}`);
  }

  return response.json();
}

type Thread = { type: number; id: string; name: string };

async function createThread(
  token: string,
  channelId: string,
  threadName: string,
  autoArchiveDuration: number
): Promise<Thread> {
  const body = JSON.stringify({
    name: threadName,
    auto_archive_duration: autoArchiveDuration,
    type: 11, // Use 11 for a public thread, 12 for a private thread, or 10 for a news thread
  });

  const headers = {
    "Content-Type": "application/json",
    Authorization: token,
  };

  const response = await fetch(
    `https://discord.com/api/v9/channels/${channelId}/threads`,
    {
      method: "POST",
      headers,
      body,
    }
  );

  if (!response.ok) {
    logger.error(`Error creating thread: ${response.statusText}`);
    throw new Error(`Error creating thread: ${response.statusText}`);
  }

  return response.json();
}

// Function to retrieve all channels in a guild and find a channel by name
async function findChannelByName(
  token: string,
  guildId: string,
  channelName: string
): Promise<ChannelType2> {
  const headers = {
    "Content-Type": "application/json",
    Authorization: token,
  };

  const response = await fetch(
    `https://discord.com/api/v9/guilds/${guildId}/channels`,
    {
      method: "GET",
      headers,
    }
  );

  if (!response.ok) {
    throw new Error(`Error fetching channels: ${response.statusText}`);
  }

  const channels = await response.json();
  console.log("%cactions.ts line:113 channels", "color: #007acc;", channels);
  return channels.find((channel: any) => channel.name === channelName);
}

export async function createBotThread(
  token: string,
  guildId: string,
  channelName: string,
  threadName: string,
  prompt: string
) {
  // Get the guild (server) that you want to create the channel in

  // create thread in channel
  let channel: ChannelType2 = await findChannelByName(
    token,
    guildId,
    channelName
  );

  logger.debug(`Found channel: ${channel?.name}`);

  if (!channel) {
    logger.debug(`Channel "${channelName}" not found, creating one...`);

    // create a new Discord channel
    channel = await createChannel(
      token,
      guildId,
      channelName,
      0 // guild text channel
    );
  }

  invariant(channel, "Channel not found");
  invariant(
    channel.type === 0, // guild text channel
    "Channel is not a text channel"
  );

  logger.debug(`Creating channelId: ${threadName})`);

  const thread = await createThread(token, channel.id, threadName, 60);

  logger.info(`Created a new thread with name 02 [${prompt}]: ${thread.name}`, {
    name: thread.name,
    id: thread.id,
    channelName: threadName,
  });

  return { threadId: thread.id, channelId: channel.id };
}
