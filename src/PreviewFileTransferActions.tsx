export type BrowserFileAction = "download" | "share";

export function PreviewFileTransferActions({ enabled, busy, onAction }: {
  enabled: boolean;
  busy: BrowserFileAction | null;
  onAction: (action: BrowserFileAction) => void;
}) {
  return <>
    <button type="button" disabled={!enabled || Boolean(busy)} onClick={() => onAction("download")}>
      {busy === "download" ? "准备下载…" : "下载文件"}
    </button>
    {typeof navigator.share === "function" ? <button type="button" disabled={!enabled || Boolean(busy)} onClick={() => onAction("share")}>
      {busy === "share" ? "准备分享…" : "分享文件"}
    </button> : null}
  </>;
}
