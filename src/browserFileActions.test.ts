import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadBrowserFile, shareBrowserFile } from "./browserFileActions";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function browser() {
  const anchor = { href: "", download: "", rel: "", click: vi.fn(), remove: vi.fn() };
  vi.stubGlobal("document", { createElement: vi.fn(() => anchor), body: { appendChild: vi.fn() } });
  const share = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { share, canShare: vi.fn(() => true) });
  const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test-download");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  return { anchor, share, create, revoke };
}

describe("explicit browser file actions", () => {
  it.each(["报告 空格.pdf", "draft.docx", "table.xlsx", "slides.pptx", "bundle.zip", "page.html", "image.png", "source.py"])("always downloads %s even when sharing is available", name => {
    vi.useFakeTimers();
    const { anchor, share, revoke, create } = browser();
    const blob = new Blob(["original bytes"], { type: "application/octet-stream" });
    downloadBrowserFile(blob, name);
    expect(create).toHaveBeenCalledWith(blob);
    expect(anchor.download).toBe(name);
    expect(anchor.href).toBe("blob:test-download");
    expect(anchor.click).toHaveBeenCalledOnce(); expect(anchor.remove).toHaveBeenCalledOnce();
    expect(share).not.toHaveBeenCalled(); expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000); expect(revoke).toHaveBeenCalledWith("blob:test-download");
  });
  it("cleans up even when the browser refuses the click", () => {
    vi.useFakeTimers();
    const { anchor, revoke } = browser();
    anchor.click.mockImplementation(() => { throw new Error("blocked"); });
    expect(() => downloadBrowserFile(new Blob([]), "empty.txt")).toThrow("blocked");
    expect(anchor.remove).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(30_000); expect(revoke).toHaveBeenCalledOnce();
  });
  it("shares only by explicit request, preserving the original filename and MIME", async () => {
    const { anchor, share } = browser();
    await shareBrowserFile(new Blob(["hello"], { type: "text/plain" }), "你好.txt");
    const data = share.mock.calls[0][0];
    expect(data.title).toBe("你好.txt"); expect(data.files[0].name).toBe("你好.txt");
    expect(data.files[0].type).toBe("text/plain"); expect(await data.files[0].text()).toBe("hello");
    expect(anchor.click).not.toHaveBeenCalled();
  });
  it("canceling sharing does not download unexpectedly", async () => {
    const { anchor, share } = browser(); share.mockRejectedValue(new DOMException("canceled", "AbortError"));
    await expect(shareBrowserFile(new Blob([]), "empty.txt")).resolves.toBeUndefined();
    expect(anchor.click).not.toHaveBeenCalled();
  });
  it("unsupported file sharing explains that direct download is still available", async () => {
    const { share } = browser(); navigator.canShare = () => false;
    await expect(shareBrowserFile(new Blob([]), "file.zip")).rejects.toThrow("下载文件");
    expect(share).not.toHaveBeenCalled();
  });
  it("a browser without Web Share can still download", () => {
    vi.useFakeTimers(); const { anchor } = browser(); vi.stubGlobal("navigator", {});
    downloadBrowserFile(new Blob([]), "zero-byte.txt"); expect(anchor.click).toHaveBeenCalledOnce();
  });
  it("a real sharing failure is reported, not silently converted to a download", async () => {
    const { anchor, share } = browser(); share.mockRejectedValue(new Error("sharing failed"));
    await expect(shareBrowserFile(new Blob([]), "file.txt")).rejects.toThrow("sharing failed");
    expect(anchor.click).not.toHaveBeenCalled();
  });
});
