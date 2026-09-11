import { REST, Routes } from "discord.js";
import { commands } from "./commands/index.js";
import { config } from "./config.js";

const rest = new REST({ version: "10" }).setToken(config.token);

await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), {
  body: commands.map((command) => command.data.toJSON())
});

console.log("Registered guild slash commands.");