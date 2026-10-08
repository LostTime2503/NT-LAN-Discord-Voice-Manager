import { pingCommand } from "./ping.js";
import { setupVoiceManagerCommand } from "./setupVoiceManager.js";
import { voiceNameCommand } from "./voiceName.js";
import { setupAccessCommand } from "./setupAccess.js";
import { giveAccessCommand } from "./giveAccess.js";
import { clearAccessOverrideCommand } from "./clearAccessOverride.js";
import { csLinkCommand } from "./csLink.js";
import { csUnlinkCommand } from "./csUnlink.js";
import { csStatusCommand } from "./csStatus.js";

export const commands = [
  pingCommand,
  setupVoiceManagerCommand,
  voiceNameCommand,
  setupAccessCommand,
  giveAccessCommand,
  clearAccessOverrideCommand,
  csLinkCommand,
  csUnlinkCommand,
  csStatusCommand
];

export function findCommand(commandName: string) {
  return commands.find((command) => command.data.name === commandName);
}