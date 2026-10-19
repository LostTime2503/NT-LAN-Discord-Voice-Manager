import { ChannelType, type Client } from "discord.js";
import { getBotSettingsController } from "./botSettingsController.js";
import { config } from "./config.js";

export type CrewLogCategory = "general" | "website-link";

export function shouldDeliverCrewLog(mode: "full" | "minimal", category: CrewLogCategory): boolean {
  return mode === "full" || category === "website-link";
}

export async function sendCrewLogMessage(
  client: Client,
  message: string,
  category: CrewLogCategory = "general"
): Promise<void> {
  const entry = message.replace(/[\r\n]+/g, " ").slice(0, 1_800);
  console.info(`[crew-audit] ${entry}`);
  const logMode = getBotSettingsController()?.getCrewLogMode() ?? "full";
  if (!config.crewLogChannelId || !shouldDeliverCrewLog(logMode, category)) {
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
