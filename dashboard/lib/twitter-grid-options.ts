export const twitterGridNumberRanges: Record<string, readonly [number, number]> = {
  twitter_grid_columns: [1, 20],
  twitter_grid_gap: [0, 64],
  twitter_grid_cell_size: [128, 2048],
  twitter_grid_quality: [30, 95],
};

export function parseTwitterGridNumber(key: string, value: unknown): number | null {
  const range = twitterGridNumberRanges[key];
  if (!range || (typeof value !== "string" && typeof value !== "number") || !/^\d+$/.test(String(value))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= range[0] && number <= range[1] ? number : null;
}

export function parseTwitterGridBackground(value: unknown): string | null {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;
}
