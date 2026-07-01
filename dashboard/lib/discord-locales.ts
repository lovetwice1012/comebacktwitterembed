export const DEFAULT_DASHBOARD_LOCALE = "ja";

export const DASHBOARD_LOCALE_OPTIONS = [
  { value: "id", flag: "🇮🇩", languageName: "Indonesian", nativeName: "Bahasa Indonesia" },
  { value: "da", flag: "🇩🇰", languageName: "Danish", nativeName: "Dansk" },
  { value: "de", flag: "🇩🇪", languageName: "German", nativeName: "Deutsch" },
  { value: "en-GB", flag: "🇬🇧", languageName: "English, UK", nativeName: "English, UK" },
  { value: "en-US", flag: "🇺🇸", languageName: "English, US", nativeName: "English, US" },
  { value: "es-ES", flag: "🇪🇸", languageName: "Spanish", nativeName: "Español" },
  { value: "es-419", flag: "🌎", languageName: "Spanish, LATAM", nativeName: "Español, LATAM" },
  { value: "fr", flag: "🇫🇷", languageName: "French", nativeName: "Français" },
  { value: "hr", flag: "🇭🇷", languageName: "Croatian", nativeName: "Hrvatski" },
  { value: "it", flag: "🇮🇹", languageName: "Italian", nativeName: "Italiano" },
  { value: "lt", flag: "🇱🇹", languageName: "Lithuanian", nativeName: "Lietuviškai" },
  { value: "hu", flag: "🇭🇺", languageName: "Hungarian", nativeName: "Magyar" },
  { value: "nl", flag: "🇳🇱", languageName: "Dutch", nativeName: "Nederlands" },
  { value: "no", flag: "🇳🇴", languageName: "Norwegian", nativeName: "Norsk" },
  { value: "pl", flag: "🇵🇱", languageName: "Polish", nativeName: "Polski" },
  { value: "pt-BR", flag: "🇧🇷", languageName: "Portuguese, Brazilian", nativeName: "Português do Brasil" },
  { value: "ro", flag: "🇷🇴", languageName: "Romanian, Romania", nativeName: "Română" },
  { value: "fi", flag: "🇫🇮", languageName: "Finnish", nativeName: "Suomi" },
  { value: "sv-SE", flag: "🇸🇪", languageName: "Swedish", nativeName: "Svenska" },
  { value: "vi", flag: "🇻🇳", languageName: "Vietnamese", nativeName: "Tiếng Việt" },
  { value: "tr", flag: "🇹🇷", languageName: "Turkish", nativeName: "Türkçe" },
  { value: "cs", flag: "🇨🇿", languageName: "Czech", nativeName: "Čeština" },
  { value: "el", flag: "🇬🇷", languageName: "Greek", nativeName: "Ελληνικά" },
  { value: "bg", flag: "🇧🇬", languageName: "Bulgarian", nativeName: "български" },
  { value: "ru", flag: "🇷🇺", languageName: "Russian", nativeName: "Русский" },
  { value: "uk", flag: "🇺🇦", languageName: "Ukrainian", nativeName: "Українська" },
  { value: "hi", flag: "🇮🇳", languageName: "Hindi", nativeName: "हिन्दी" },
  { value: "th", flag: "🇹🇭", languageName: "Thai", nativeName: "ไทย" },
  { value: "zh-CN", flag: "🇨🇳", languageName: "Chinese, China", nativeName: "中文" },
  { value: "ja", flag: "🇯🇵", languageName: "Japanese", nativeName: "日本語" },
  { value: "zh-TW", flag: "🇹🇼", languageName: "Chinese, Taiwan", nativeName: "繁體中文" },
  { value: "ko", flag: "🇰🇷", languageName: "Korean", nativeName: "한국어" },
] as const;

export type DashboardLocaleOption = (typeof DASHBOARD_LOCALE_OPTIONS)[number];
export type DiscordLocale = DashboardLocaleOption["value"];

export const DASHBOARD_LOCALES = DASHBOARD_LOCALE_OPTIONS.map((option) => option.value) as DiscordLocale[];

const LOCALE_ALIASES: Record<string, DiscordLocale> = {
  en: "en-US",
  "ko-KR": "ko",
};

const localeByLowercase = new Map<string, DiscordLocale>();
for (const locale of DASHBOARD_LOCALES) localeByLowercase.set(locale.toLowerCase(), locale);
for (const [alias, locale] of Object.entries(LOCALE_ALIASES)) localeByLowercase.set(alias.toLowerCase(), locale);

export function normalizeDiscordLocale(value: string | null | undefined): DiscordLocale | null {
  const text = String(value || "").trim();
  if (!text) return null;
  return localeByLowercase.get(text.toLowerCase()) || null;
}

export function isDiscordLocale(value: string | null | undefined): value is DiscordLocale {
  return normalizeDiscordLocale(value) === value;
}
