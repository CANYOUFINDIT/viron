export async function filterAsync<T>(
  items: readonly T[],
  predicate: (item: T, index: number) => boolean | Promise<boolean>,
): Promise<T[]> {
  const matches = await Promise.all(items.map(predicate));
  return items.filter((_item, index) => matches[index]);
}
