import { ChannelType, type Client } from "discord.js";
import { config } from "./config.js";

export async function sendCrewLogMessage(client: Client, message: string): Promise<void> {
  const entry = message.replace(/[\r\n]+/g, " ").slice(0, 1_800);
  console.info(`[crew-audit] ${entry}`);
  if (!config.crewLogChannelId) {
    return;
  }

  try {
    const channel = await client.channels.fetch(config.crewLogChannelId);

    if (!channel || channel.type !== ChannelType.GuildText) {
      return;
    }

    await channel.send({ content: entry, allowedMentions: { parse: [] } });
  } catch {
    console.error("Failed to deliver crew audit entry to CREW_LOG_CHANNEL_ID; see Dockhand logs.");
  }
}
