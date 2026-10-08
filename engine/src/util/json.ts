// JSON helpers for values that carry bigint amounts (zats, raw token units).
export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function toJson(value: unknown): string {
  return JSON.stringify(value, bigintReplacer);
}
