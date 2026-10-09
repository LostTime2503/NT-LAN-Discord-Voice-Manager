import { PermissionFlagsBits, type OverwriteResolvable } from "discord.js";

export interface ParentVoiceOverwrite {
  id: string;
  type: number;
  allow: { bitfield: bigint };
  deny: { bitfield: bigint };
}

export function createTemporaryVoiceOverwrites(
  parentOverwrites: readonly ParentVoiceOverwrite[],
  memberId: string,
  grantManageChannels: boolean
): OverwriteResolvable[] {
  return [
    ...parentOverwrites.map(overwrite => ({
      id: overwrite.id,
      type: overwrite.type,
      allow: overwrite.allow.bitfield,
      deny: overwrite.deny.bitfield
    })),
    {
      id: memberId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        ...(grantManageChannels ? [PermissionFlagsBits.ManageChannels] : [])
      ]
    }
  ];
}