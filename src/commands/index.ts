import { pingCommand } from "./ping.js";
import {
  mealStatusCommand,
  cancelMealPlanCommand,
  listMealPlansCommand,
  matAnnouncementCommand,
  notifyPuljeOneCommand,
  notifyPuljeTwoCommand,
  planMealCommand,
  setMealTimeCommand,
  setupNameAndPuljeCommand
} from "./matCatering.js";
import { setupVoiceManagerCommand } from "./setupVoiceManager.js";
import { voiceNameCommand } from "./voiceName.js";

export const commands = [
  pingCommand,
  setupVoiceManagerCommand,
  voiceNameCommand,
  setupNameAndPuljeCommand,
  matAnnouncementCommand,
  notifyPuljeOneCommand,
  notifyPuljeTwoCommand,
  planMealCommand,
  setMealTimeCommand,
  mealStatusCommand,
  listMealPlansCommand,
  cancelMealPlanCommand
];

export function findCommand(commandName: string) {
  return commands.find((command) => command.data.name === commandName);
}