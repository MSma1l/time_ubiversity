/**
 * Romanian count phrase for minutes, same rule as frontend/src/labels.ts:
 * "1 minut", "5 minute", "19 minute", "20 de minute", "101 minute", "120 de minute".
 * Numbers whose last two digits are 20–99 (or exact hundreds) take "de".
 */
export function minutesLabel(count: number) {
  const value = Math.abs(count);
  if (value === 1) return `${count} minut`;
  const rest = value % 100;
  return rest >= 20 || (value >= 100 && rest === 0) ? `${count} de minute` : `${count} minute`;
}
