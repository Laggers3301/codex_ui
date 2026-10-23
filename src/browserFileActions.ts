/** Download and system sharing are deliberately separate user actions. */
export function downloadBrowserFile(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  try {
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    // Safari may still be consuming the object URL after click returns.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

export async function shareBrowserFile(blob: Blob, fileName: string): Promise<void> {
  const file = new File([blob], fileName, { type: blob.type || "application/octet-stream" });
  const data: ShareData = { files: [file], title: fileName };
  if (typeof navigator.share !== "function" || (typeof navigator.canShare === "function" && !navigator.canShare(data))) {
    throw new Error("当前浏览器不支持分享此格式，请选择「下载文件」。");
  }
  try {
    await navigator.share(data);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    throw error;
  }
}
