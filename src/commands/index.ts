import { pingCommand } from "./ping.js";
import { setupVoiceManagerCommand } from "./setupVoiceManager.js";
import { voiceNameCommand } from "./voiceName.js";

export const commands = [pingCommand, setupVoiceManagerCommand, voiceNameCommand];

export function findCommand(commandName: string) {
  return commands.find((command) => command.data.name === commandName);
}