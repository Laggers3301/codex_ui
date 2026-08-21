import {
  forwardRef,
  Children,
  isValidElement,
  memo,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type HTMLAttributes,
  type ReactNode,
  type Ref
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

export interface VirtualConversationHandle {
  scrollToKey(key: string, align?: "start" | "center" | "end" | "auto"): boolean;
  scrollToEnd(behavior?: "auto" | "smooth" | "instant"): void;
  isAtEnd(threshold?: number): boolean;
  measure(): void;
  captureHistoryAnchor(): void;
}

interface VirtualConversationProps extends HTMLAttributes<HTMLDivElement> {
  containerRef?: Ref<HTMLDivElement>;
  threadKey: string;
}

function setRefValue<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (!ref) return;
  if (typeof ref === "function") ref(value);
  else (ref as { current: T | null }).current = value;
}

function stableRowKey(node: ReactNode, index: number): string {
  if (!isValidElement<Record<string, unknown>>(node)) return `row-${index}`;
  const turnId = node.props["data-turn-id"];
  if (typeof turnId === "string" && turnId) return `turn:${turnId}`;
  if (node.key === null) return `row-${index}`;
  const reactKey = String(node.key);
  const leafKey = reactKey.includes("$") ? reactKey.slice(reactKey.lastIndexOf("$") + 1) : reactKey;
  return leafKey.replace(/=0/g, "=").replace(/=2/g, ":");
}

function VirtualConversationInner(
  { children, containerRef, threadKey, className, onScroll, onWheel, onPointerUp, onTouchEnd, ...containerProps }: VirtualConversationProps,
  forwardedRef: Ref<VirtualConversationHandle>
) {
  const rows = Children.toArray(children).map((node, index) => ({
    key: stableRowKey(node, index),
    node
  }));
  const scrollElementRef = useRef<HTMLDivElement | null>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const layoutModeRef = useRef({ threadKey, useFlowLayout: rows.length <= 240 });
  if (layoutModeRef.current.threadKey !== threadKey) {
    layoutModeRef.current = { threadKey, useFlowLayout: rows.length <= 240 };
  }
  // Never swap positioning models while prepending history. Moving from normal
  // document flow to estimated virtual offsets in the same update invalidates
  // the visible-row anchor and can move it by several thousand pixels.
  const useFlowLayout = layoutModeRef.current.useFlowLayout;
  const flowAnchorRef = useRef<{ key: string; offset: number } | null>(null);
  const flowAnchorApplyingRef = useRef(false);
  const flowAnchorCleanupRef = useRef<(() => void) | null>(null);
  const rowSignature = `${rows.length}:${rows[0]?.key ?? "empty"}`;

  function captureFlowAnchor(): void {
    if (!useFlowLayout) return;
    const container = scrollElementRef.current;
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    const visibleRow = [...container.querySelectorAll<HTMLElement>(".virtualConversationFlowRow")]
      .find((row) => row.getBoundingClientRect().bottom > containerRect.top + 1);
    if (!visibleRow?.dataset.rowKey) return;
    flowAnchorRef.current = {
      key: visibleRow.dataset.rowKey,
      offset: visibleRow.getBoundingClientRect().top - containerRect.top
    };
  }

  const virtualizer = useVirtualizer({
    count: useFlowLayout ? 0 : rows.length,
    getScrollElement: () => useFlowLayout ? null : scrollElementRef.current,
    estimateSize: () => 260,
    getItemKey: (index) => rowsRef.current[index]?.key ?? index,
    // A history page usually contains far fewer than 100 logical turns. Mount
    // that page's turns together so their real heights settle before a fast
    // upward gesture reaches them; genuinely long loaded histories remain
    // virtualized beyond this window.
    overscan: 100,
    useAnimationFrameWithResizeObserver: false,
    anchorTo: "end",
    followOnAppend: "auto",
    scrollEndThreshold: 120,
    isScrollingResetDelay: 500,
    useScrollendEvent: true,
    enabled: !useFlowLayout
  });

  useImperativeHandle(forwardedRef, () => ({
    scrollToKey(key, align = "auto") {
      if (useFlowLayout) {
        const container = scrollElementRef.current;
        const target = container?.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(key)}"]`);
        if (!container || !target) return false;
        const top = target.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
        const targetTop = align === "center"
          ? top - (container.clientHeight - target.offsetHeight) / 2
          : align === "end"
            ? top - container.clientHeight + target.offsetHeight
            : top;
        container.scrollTo({ top: Math.max(0, targetTop), behavior: "auto" });
        return true;
      }
      const index = rowsRef.current.findIndex((row) => row.key === key);
      if (index < 0) return false;
      virtualizer.scrollToIndex(index, { align, behavior: "auto" });
      return true;
    },
    scrollToEnd(behavior = "auto") {
      if (useFlowLayout) {
        const container = scrollElementRef.current;
        container?.scrollTo({ top: container.scrollHeight, behavior });
        return;
      }
      virtualizer.scrollToEnd({ behavior });
    },
    isAtEnd(threshold = 120) {
      if (useFlowLayout) {
        const container = scrollElementRef.current;
        return Boolean(container && container.scrollHeight - container.scrollTop - container.clientHeight <= threshold);
      }
      return virtualizer.isAtEnd(threshold);
    },
    measure() {
      if (!useFlowLayout) virtualizer.measure();
    },
    captureHistoryAnchor() {
      flowAnchorCleanupRef.current?.();
      flowAnchorCleanupRef.current = null;
      captureFlowAnchor();
    }
  }), [useFlowLayout, virtualizer]);

  useLayoutEffect(() => {
    if (!useFlowLayout || !flowAnchorRef.current) return;
    const container = scrollElementRef.current;
    if (!container) return;

    const restore = () => {
      const anchor = flowAnchorRef.current;
      if (!anchor) return;
      const target = container.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(anchor.key)}"]`);
      if (!target) return;
      const delta = target.getBoundingClientRect().top - container.getBoundingClientRect().top - anchor.offset;
      if (Math.abs(delta) < 0.5) return;
      flowAnchorApplyingRef.current = true;
      container.scrollTop += delta;
      flowAnchorApplyingRef.current = false;
    };

    restore();
    const flow = container.querySelector<HTMLElement>(".virtualConversationFlow");
    const observer = flow ? new ResizeObserver(restore) : null;
    if (flow) observer?.observe(flow);
    const frame = window.requestAnimationFrame(restore);
    const timer = window.setTimeout(() => {
      observer?.disconnect();
      flowAnchorRef.current = null;
      flowAnchorCleanupRef.current = null;
    }, 1_500);
    flowAnchorCleanupRef.current = () => {
      observer?.disconnect();
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
    return flowAnchorCleanupRef.current;
  }, [rowSignature, useFlowLayout]);

  useLayoutEffect(() => () => flowAnchorCleanupRef.current?.(), []);

  useLayoutEffect(() => {
    if (!useFlowLayout) virtualizer.measure();
    const frame = window.requestAnimationFrame(() => {
      if (useFlowLayout) {
        const container = scrollElementRef.current;
        container?.scrollTo({ top: container.scrollHeight, behavior: "auto" });
      } else {
        virtualizer.scrollToEnd({ behavior: "auto" });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [threadKey, useFlowLayout, virtualizer]);

  const virtualItems = virtualizer.getVirtualItems();
  return (
    <div
      {...containerProps}
      className={className}
      onScroll={onScroll}
      onScrollCapture={(event) => {
        containerProps.onScrollCapture?.(event);
        if (flowAnchorRef.current && !flowAnchorApplyingRef.current) captureFlowAnchor();
      }}
      onWheel={(event) => {
        onWheel?.(event);
      }}
      onPointerUp={(event) => {
        onPointerUp?.(event);
      }}
      onTouchEnd={(event) => {
        onTouchEnd?.(event);
      }}
      ref={(element) => {
        scrollElementRef.current = element;
        setRefValue(containerRef, element);
      }}
    >
      {useFlowLayout ? (
        <div className="virtualConversationFlow">
          {rows.map((row, index) => (
            <div
              className="virtualConversationFlowRow"
              data-index={index}
              data-row-key={row.key}
              key={row.key}
            >
              {row.node}
            </div>
          ))}
        </div>
      ) : (
        <div className="virtualConversationSizer" style={{ height: virtualizer.getTotalSize() }}>
          {virtualItems.map((virtualRow) => {
            const row = rows[virtualRow.index];
            if (!row) return null;
            return (
            <div
              className="virtualConversationRow"
              data-index={virtualRow.index}
              data-row-key={row.key}
              key={virtualRow.key}
              ref={virtualizer.measureElement}
              style={{ top: `${Math.round(virtualRow.start)}px` }}
            >
              {row.node}
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export const VirtualConversation = memo(forwardRef(VirtualConversationInner));
