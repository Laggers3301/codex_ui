/** Fixed, validated official API requests. Never accept arbitrary URLs or tokens. */
export type FeishuOperation = {
  label: string;
  domain: string;
  write?: boolean;
  build: (args: Record<string, any>) => {
    method?: string;
    path: string;
    query?: Record<string, any>;
    body?: unknown;
    download?: { filename?: string };
  };
};
