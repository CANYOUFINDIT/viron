/** First grapheme of a single word, or the first grapheme of each of the first two words. */
export function nameInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "";
  const take = words.length === 1 ? [words[0]] : words.slice(0, 2);
  return take.map((word) => (Array.from(word)[0] ?? "").toLocaleUpperCase()).join("");
}
