import { forwardRef, useId, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FileEditing, X } from "./PanelIcons";
import { ComposerMathPreview } from "./ComposerMathPreview";
import { useMobileLayer } from "./mobile/MobileLayerProvider";
import "./composerLongText.css";

const release = "2026-10-29-composer-long-text-switch-fix-v1";

export type ComposerLongTextHandle = { open: () => void };
export const ComposerLongText = forwardRef<ComposerLongTextHandle, {
  value: string;
  onChange: (value: string) => void;
  userId: string;
  disabled?: boolean;
  hideTrigger?: boolean;
  onClose?: () => void;
}>(function ComposerLongText({ value, onChange, userId, disabled = false, hideTrigger = false, onClose }, controller) {
  const titleId = useId(), hintId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState(false);
  // The release dot belongs to this entry and account, without publishing an
  // unrelated account/plugins notice or resetting any existing read receipts.
  const seenKey = `codex-web-ui-update-seen:${encodeURIComponent(userId)}:composer-long-text:${release}`;
  const [unseen, setUnseen] = useState(() => {
    try { return localStorage.getItem(seenKey) !== "1"; }
    catch { return true; }
  });

  useLayoutEffect(() => {
    if (!open) return;
    // Marks the page as locked while the dialog is open (a body:has() rule restyled the document on every mutation).
    document.body.classList.add("composerLongTextOpen");
    const dialog = dialogRef.current!;
    const viewport = window.visualViewport;
    const update = () => {
      // iOS can pan the visual viewport while its keyboard is open. Anchor the
      // whole dialog, including Done, to that visible area rather than 100vh.
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      const gap = width <= 720 ? 8 : 16;
      const panelWidth = Math.max(0, Math.min(760, width - gap * 2));
      const panelHeight = Math.max(0, Math.min(760, height - gap * 2));
      Object.assign(dialog.style, {
        left: `${(viewport?.offsetLeft ?? 0) + (width - panelWidth) / 2}px`,
        top: `${(viewport?.offsetTop ?? 0) + (height - panelHeight) / 2}px`,
        width: `${panelWidth}px`, height: `${panelHeight}px`,
      });
    };
    update();
    window.addEventListener("resize", update);
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    return () => {
      document.body.classList.remove("composerLongTextOpen");
      window.removeEventListener("resize", update);
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
    };
  }, [open]);

  const close = () => {
    textareaRef.current?.blur();
    dialogRef.current?.close();
    setOpen(false);
    setPreview(false);
    triggerRef.current?.focus({ preventScroll: true });
    onClose?.();
  };
  useMobileLayer(open, close);
  const expand = () => {
    if (disabled) return;
    dialogRef.current?.showModal();
    setOpen(true);
    setUnseen(false);
    try { localStorage.setItem(seenKey, "1"); } catch { /* Editing also works without browser storage. */ }
    // Keep focus inside the trusted tap so mobile browsers can open the keyboard.
    textareaRef.current?.focus({ preventScroll: true });
    textareaRef.current?.setSelectionRange(value.length, value.length);
  };
  useImperativeHandle(controller, () => ({ open: expand }));

  return <>
    {!hideTrigger ? <button ref={triggerRef} className="composerLongTextTrigger" type="button" onClick={expand}
      disabled={disabled} title="长文本输入" aria-label="长文本输入" aria-haspopup="dialog" aria-expanded={open}>
      <FileEditing size={16} /><span className="composerLongTextLabel">长文本</span>
      {unseen ? <i className="composerLongTextUpdate" aria-hidden="true" /> : null}
    </button> : null}
    {createPortal(<dialog ref={dialogRef} className="composerLongTextDialog" aria-labelledby={titleId} aria-describedby={hintId}
      onClose={() => setOpen(false)} onCancel={event => { event.preventDefault(); close(); }}
      onKeyDown={event => event.stopPropagation()} onPaste={event => event.stopPropagation()}>
      <header>
        <h2 id={titleId}>长文本输入</h2>
        <button type="button" className="composerLongTextClose" onClick={close} aria-label="关闭长文本输入"><X size={19} /></button>
      </header>
      <p id={hintId}>回车换行，内容自动保留在当前草稿中。</p>
      <textarea ref={textareaRef} value={value} onChange={event => onChange(event.target.value)} readOnly={disabled} hidden={preview}
        aria-label="长文本内容" placeholder="在这里输入或粘贴长文本…" enterKeyHint="enter" spellCheck={false}
        autoCapitalize="off" autoCorrect="off" />
      {open && preview ? <ComposerMathPreview value={value} /> : null}
      <footer><span>完成后可在对话中发送</span>
        <button type="button" className="composerLongTextPreviewToggle" aria-pressed={preview} onClick={() => {
          setPreview(current => !current);
          if (preview) requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }));
        }}>{preview ? "返回编辑" : "预览"}</button>
        <button type="button" className="composerLongTextDone" onClick={close}>完成</button></footer>
    </dialog>, document.body)}
  </>;
});
