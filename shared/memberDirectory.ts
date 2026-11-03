// Optional deployment-local display names. Keep personal rosters out of the public repository.
export const memberDirectory: Readonly<Record<string, string>> = {};

export function memberRealName(userId: string): string | null {
  return Object.hasOwn(memberDirectory, userId) ? memberDirectory[userId] : null;
}
