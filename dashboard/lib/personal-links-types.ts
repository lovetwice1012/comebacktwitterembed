export type PersonalKind = "saved" | "reminder" | "restock";
export type PersonalItem = {
  id: string; kind: PersonalKind; url: string; title: string; updatedAt: number;
  tags?: string[]; note?: string; dueAt?: number; timeZone?: string;
  variationId?: string; variationName?: string; status?: string; lastError?: string | null;
  editable: boolean; cancellable: boolean;
};
export type PersonalList = { items: PersonalItem[]; hasMore: boolean };
export type StockOption = { id: string; name: string; state: string };
