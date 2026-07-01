import type { PermissionSummary } from "@/lib/types";

const FLAGS = {
  Administrator: 1n << 3n,
  ManageChannels: 1n << 4n,
  ManageGuild: 1n << 5n,
  ManageMessages: 1n << 13n,
};

function has(raw: bigint, flag: bigint) {
  return (raw & flag) === flag;
}

export function parsePermissions(value: string | number | bigint | null | undefined): PermissionSummary {
  const raw = BigInt(value || 0);
  return {
    administrator: has(raw, FLAGS.Administrator),
    manageGuild: has(raw, FLAGS.ManageGuild),
    manageChannels: has(raw, FLAGS.ManageChannels),
    manageMessages: has(raw, FLAGS.ManageMessages),
    raw: raw.toString(),
  };
}

export function canViewSettings(permissions: PermissionSummary) {
  return permissions.administrator || permissions.manageGuild || permissions.manageChannels;
}

export function canEditSettings(permissions: PermissionSummary) {
  return canViewSettings(permissions);
}

export function canManageGuildSettings(permissions: PermissionSummary) {
  return permissions.administrator || permissions.manageGuild;
}

export function canAdministerMedia(permissions: PermissionSummary) {
  return permissions.administrator;
}

export function permissionRequirementText(kind: "view" | "edit" | "manage" | "media") {
  if (kind === "manage") return "Manage Server or Administrator";
  if (kind === "media") return "Administrator";
  return "Manage Channels, Manage Server, or Administrator";
}
