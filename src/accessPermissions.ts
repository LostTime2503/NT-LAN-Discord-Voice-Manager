import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  OverwriteType, PermissionFlagsBits, type Guild, type GuildChannel
} from "discord.js";
import type { AccessManager } from "./accessManager.js";

interface SavedChannel {
  id: string;
  overwrites: { id: string; type: OverwriteType; allow: string; deny: string }[];
}
interface PermissionBackup {
  guildId: string;
  channels: SavedChannel[];
}

const backupPath = join(process.cwd(), "data", "access-permissions-backup.json");

async function readBackup(): Promise<PermissionBackup | undefined> {
  try {
    const value = JSON.parse(await readFile(backupPath, "utf8")) as PermissionBackup;
    if (!value || typeof value.guildId !== "string" || !Array.isArray(value.channels)
      || value.channels.some((channel) => typeof channel.id !== "string" || !Array.isArray(channel.overwrites)
        || channel.overwrites.some((overwrite) => !/^\d+$/.test(overwrite.allow) || !/^\d+$/.test(overwrite.deny)
          || typeof overwrite.id !== "string" || ![OverwriteType.Role, OverwriteType.Member].includes(overwrite.type)))) {
      throw new Error("Invalid access permission backup.");
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function restoreAccessPermissions(guild: Guild, manager: AccessManager): Promise<number> {
  const backup = await readBackup();
  if (!backup || backup.guildId !== guild.id) throw new Error("No matching permission backup found.");
  await guild.channels.fetch();
  const me = await guild.members.fetchMe();
  for (const saved of backup.channels) {
    const channel = guild.channels.cache.get(saved.id);
    if (!channel || channel.isThread() || !channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageRoles)) {
      throw new Error("Cannot restore every saved channel. Check deleted channels and bot permissions.");
    }
  }
  if (!manager.settings.dryRun) {
    for (const saved of backup.channels) {
      const channel = guild.channels.cache.get(saved.id)! as GuildChannel;
      await channel.permissionOverwrites.set(saved.overwrites.map((overwrite) => ({
        ...overwrite, allow: BigInt(overwrite.allow), deny: BigInt(overwrite.deny)
      })), "Restore access permission backup");
    }
  }
  return backup.channels.length;
}