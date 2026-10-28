export interface HostResources {
  sampledAt: string;
  intervalMs: number | null;
  hostname: string;
  platform: string;
  cpu: { cores: number; model: string; usagePercent: number | null; loadAverage: number[] | null };
  memory: { totalBytes: number; availableBytes: number; usedBytes: number; usagePercent: number; swapTotalBytes: number | null; swapUsedBytes: number | null };
  volumes: Array<{ labels: string[]; paths: Array<{ label: string; path: string }>; mountPoints: string[]; totalBytes: number; usedBytes: number; availableBytes: number; usagePercent: number }>;
  disks: Array<{ name: string; mountPoints: string[]; readBytesPerSecond: number | null; writeBytesPerSecond: number | null; busyPercent: number | null }>;
  warnings: string[];
}

export interface HostNetworkProbeResult {
  target: "google.com";
  startedAt: string;
  durationMs: number;
  status: "reachable" | "timeout" | "dns_error" | "unavailable" | "permission_denied" | "unreachable" | "error";
  message: string;
  address: string | null;
  packetsTransmitted: number | null;
  packetsReceived: number | null;
  packetLossPercent: number | null;
  averageLatencyMs: number | null;
  output: string;
}
