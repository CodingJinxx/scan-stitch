export function pushRecent(list: string[], folder: string, max = 5): string[] {
  if (typeof folder !== 'string' || folder.trim() === '') return [...list];
  const key = folder.toLowerCase();
  const rest = list.filter((f) => f.toLowerCase() !== key);
  return [folder, ...rest].slice(0, max);
}
