export interface HostResources {
  sampledAt: string;
  intervalMs: number | null;
  hostname: string;
  platform: string;
  cpu: { cores: number; model: string; usagePercent: number | null; loadAverage: number[] | null };
  memory: { totalBytes: number; availableBytes: number; usedBytes: number; usagePercent: number; swapTotalBytes: number | null; swapUsedBytes: number | null };
  volumes: Array<{ labels: string[]; totalBytes: number; usedBytes: number; availableBytes: number; usagePercent: number }>;
  disks: Array<{ name: string; readBytesPerSecond: number | null; writeBytesPerSecond: number | null; busyPercent: number | null }>;
  warnings: string[];
}
