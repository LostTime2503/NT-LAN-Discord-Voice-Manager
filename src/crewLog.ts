import { ChannelType, type Client } from "discord.js";
import { config } from "./config.js";

export async function sendCrewLogMessage(client: Client, message: string): Promise<void> {
  if (!config.crewLogChannelId) {
    return;
  }

  try {
    const channel = await client.channels.fetch(config.crewLogChannelId);

    if (!channel || channel.type !== ChannelType.GuildText) {
      return;
    }

    await channel.send(message);
  } catch (error) {
    console.error("Failed to send crew log message", error);
  }
}
