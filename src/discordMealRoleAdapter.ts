import { PermissionFlagsBits, type Client } from "discord.js";
import type { MealRoleAdapter, MealRoleChangeSummary } from "./mealParticipantRoleRuntime.js";

export class DiscordJsMealRoleAdapter implements MealRoleAdapter {
  constructor(
    private readonly client: Client,
    private readonly guildId: string,
    private readonly roundOneRoleId: string,
    private readonly roundTwoRoleId: string
  ) {}

  async validate(): Promise<void> {
    const guild = await this.client.guilds.fetch(this.guildId);
    const [roundOne, roundTwo, bot] = await Promise.all([
      guild.roles.fetch(this.roundOneRoleId),
      guild.roles.fetch(this.roundTwoRoleId),
      guild.members.fetchMe()
    ]);
    if (!roundOne || !roundTwo || roundOne.id === roundTwo.id || roundOne.managed || roundTwo.managed
      || roundOne.id === guild.id || roundTwo.id === guild.id
      || !bot.permissions.has(PermissionFlagsBits.ManageRoles)
      || bot.roles.highest.comparePositionTo(roundOne) <= 0
      || bot.roles.highest.comparePositionTo(roundTwo) <= 0) {
      throw new Error("FOOD_ROUND_1_ROLE_ID and FOOD_ROUND_2_ROLE_ID must be distinct roles below the bot, with Manage Roles.");
    }
  }

  async syncMealRoles(memberId: string, hasRoundOneMeal: boolean, hasRoundTwoMeal: boolean): Promise<MealRoleChangeSummary> {
    const guild = await this.client.guilds.fetch(this.guildId);
    const result: MealRoleChangeSummary = {
      roundOneAdded: 0,
      roundOneRemoved: 0,
      roundTwoAdded: 0,
      roundTwoRemoved: 0,
      unchanged: 0
    };
    let member;
    try {
      member = await guild.members.fetch(memberId);
    } catch {
      return { ...result, unchanged: 1 };
    }
    if (member.user.bot) return { ...result, unchanged: 1 };
    const bot = guild.members.me ?? await guild.members.fetchMe();
    if (!member.manageable || member.roles.highest.comparePositionTo(bot.roles.highest) >= 0) {
      throw new Error("Meal role target is above the bot role hierarchy.");
    }

    const roles = [
      { id: this.roundOneRoleId, desired: hasRoundOneMeal, key: "roundOne" as const },
      { id: this.roundTwoRoleId, desired: hasRoundTwoMeal, key: "roundTwo" as const }
    ];
    for (const entry of roles) {
      const role = await guild.roles.fetch(entry.id);
      if (!role || role.managed || bot.roles.highest.comparePositionTo(role) <= 0) {
        throw new Error("Configured meal role is missing or not manageable by the bot.");
      }
      const hasRole = member.roles.cache.has(role.id);
      if (hasRole === entry.desired) {
        result.unchanged += 1;
        continue;
      }
      if (entry.desired) {
        await member.roles.add(role, "NT-LAN API lists a Saturday meal in this pulje");
        result[entry.key === "roundOne" ? "roundOneAdded" : "roundTwoAdded"] += 1;
      } else {
        await member.roles.remove(role, "NT-LAN API no longer lists a Saturday meal in this pulje");
        result[entry.key === "roundOne" ? "roundOneRemoved" : "roundTwoRemoved"] += 1;
      }
    }
    return result;
  }
}