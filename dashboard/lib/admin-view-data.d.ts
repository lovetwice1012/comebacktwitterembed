declare const presentation: {
  outcomes: Record<string, string>;
  deliveryOutcomes: Record<string, string>;
  result(value: unknown, context?: Record<string, unknown>): { label: string; contract: string; code: string };
};
export = presentation;
