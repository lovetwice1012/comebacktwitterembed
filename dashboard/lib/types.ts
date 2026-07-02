export type LocaleText = string | { en?: string; ja?: string; [key: string]: string | undefined };

export type SettingKind =
  | "overview"
  | "providerEnabled"
  | "bool"
  | "choice"
  | "multiChoice"
  | "targets"
  | "buttonVisibility"
  | "bannedWords"
  | "outputVisibility"
  | "accountDepthMap";

export type SettingChoice = {
  label: LocaleText;
  value: string;
};

export type OutputItem = {
  value: string;
  label: LocaleText;
  description?: LocaleText;
};

export type SettingSpec = {
  key: string;
  settingKey?: string;
  label: LocaleText;
  description: LocaleText;
  kind: SettingKind;
  choices?: SettingChoice[];
  outputItems?: OutputItem[];
  category?: string;
  impactLevel?: "low" | "medium" | "high" | "danger";
  recommended?: boolean;
  advanced?: boolean;
  dependencies?: string[];
  conflicts?: string[];
  dbColumn?: string | null;
};

export type ProviderCatalogItem = {
  providerId: string;
  label: string;
  enabledByDefault: boolean;
  settings: SettingSpec[];
};

export type TargetSetting = {
  user: string[];
  channel: string[];
  role: string[];
};

export type ButtonVisibility = Record<string, boolean>;
export type AccountDepthMap = Record<string, number>;

export type SettingValue =
  | string
  | number
  | boolean
  | null
  | string[]
  | TargetSetting
  | ButtonVisibility
  | AccountDepthMap;

export type SettingState = {
  key: string;
  kind: SettingKind;
  spec: SettingSpec;
  value: SettingValue;
  rawValue: SettingValue | undefined;
  defaultValue: SettingValue | undefined;
  customized: boolean;
  changedFromDefault: boolean;
  warnings: string[];
  dependencies?: string[];
  conflicts?: string[];
};

export type DashboardUser = {
  id: string;
  username: string;
  globalName?: string | null;
  avatarUrl?: string | null;
  isAdmin: boolean;
};

export type DashboardSession = {
  user: DashboardUser;
  accessToken: string;
  expiresAt: number;
};

export type PermissionSummary = {
  administrator: boolean;
  manageGuild: boolean;
  manageChannels: boolean;
  manageMessages: boolean;
  raw: string;
};

export type GuildAccess = {
  guildId: string;
  name: string;
  iconUrl: string | null;
  botInstalled: boolean;
  canView: boolean;
  canEdit: boolean;
  canManageGuild: boolean;
  permissions: PermissionSummary;
};

export type ProviderSummary = {
  enabled: number;
  disabled: number;
  total: number;
};

export type AuditActor = {
  id: string;
  username?: string | null;
};
