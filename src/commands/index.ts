import { pingCommand } from "./ping.js";
import { setupVoiceManagerCommand } from "./setupVoiceManager.js";
import { voiceNameCommand } from "./voiceName.js";
import { setupAccessCommand } from "./setupAccess.js";

export const commands = [pingCommand, setupVoiceManagerCommand, voiceNameCommand, setupAccessCommand];

export function findCommand(commandName: string) {
  return commands.find((command) => command.data.name === commandName);
}