import { localDateKey } from "../workflow";

export function cachedFields<T extends Record<string, string>>(key: string, defaults: T): T {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) || "null");
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      return Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, typeof record[key] === "string" ? record[key] : fallback])) as T;
    }
  } catch { /* Cache failure must not prevent editing. */ }
  return defaults;
}

export function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00`);
  return Number.isFinite(date.getTime()) && localDateKey(date) === value;
}
