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
  cancelScroll(): void;
}

interface VirtualConversationProps extends HTMLAttributes<HTMLDivElement> {
  containerRef?: Ref<HTMLDivElement>;
  threadKey: string;
  virtualize?: boolean;
  historyRevision?: number;
  shouldFollowEnd?: () => boolean;
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
  { children, containerRef, threadKey, virtualize = false, historyRevision = 0, shouldFollowEnd, className, onScroll, onWheel, onTouchStart, onTouchMove, onPointerDown, onPointerUp, onTouchEnd, onKeyDown, ...containerProps }: VirtualConversationProps,
  forwardedRef: Ref<VirtualConversationHandle>
) {
  const rows = Children.toArray(children).map((node, index) => ({
    key: stableRowKey(node, index),
    node
  }));
  const scrollElementRef = useRef<HTMLDivElement | null>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const layoutModeRef = useRef({ threadKey, useFlowLayout: !virtualize && rows.length <= 240 });
  if (layoutModeRef.current.threadKey !== threadKey) {
    layoutModeRef.current = { threadKey, useFlowLayout: !virtualize && rows.length <= 240 };
  }
  // Never swap positioning models while prepending history. Moving from normal
  // document flow to estimated virtual offsets in the same update invalidates
  // the visible-row anchor and can move it by several thousand pixels.
  const useFlowLayout = layoutModeRef.current.useFlowLayout;
  const flowAnchorRef = useRef<{
    key: string;
    offset: number;
    messageKey?: string;
    messageOffset?: number;
    fallbackMessageKey?: string;
    fallbackMessageOffset?: number;
    scrollTop: number;
    scrollHeight: number;
    threadKey: string;
  } | null>(null);
  const flowAnchorApplyingRef = useRef(false);
  const historyAnchorRestoringRef = useRef(false);
  const flowAnchorCleanupRef = useRef<(() => void) | null>(null);
  const scrollMotionFrameRef = useRef<number | null>(null);
  const rowSignature = `${rows.length}:${rows[0]?.key ?? "empty"}`;

  function releaseHistoryAnchor(): void {
    flowAnchorCleanupRef.current?.();
    flowAnchorCleanupRef.current = null;
    flowAnchorRef.current = null;
    historyAnchorRestoringRef.current = false;
    scrollElementRef.current?.style.removeProperty("overflow-anchor");
  }

  function cancelSmoothEnd(): void {
    if (scrollMotionFrameRef.current !== null) window.cancelAnimationFrame(scrollMotionFrameRef.current);
    scrollMotionFrameRef.current = null;
  }

  function captureVisibleAnchor(): void {
    const container = scrollElementRef.current;
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    const selector = useFlowLayout ? ".virtualConversationFlowRow" : ".virtualConversationRow";
    const visibleRows = [...container.querySelectorAll<HTMLElement>(selector)]
      .filter((row) => {
        const bounds = row.getBoundingClientRect();
        return bounds.bottom > containerRect.top + 1 && bounds.top < containerRect.bottom;
      });
    const visibleMessages = [...container.querySelectorAll<HTMLElement>("[data-message-key]")]
      .filter((message) => {
        const bounds = message.getBoundingClientRect();
        return bounds.bottom > containerRect.top + 1 && bounds.top < containerRect.bottom;
      });
    // A clipped sliver from the prior message must not displace the first
    // fully readable message at the pagination boundary.
    // A tool bundle can keep its key while older calls are prepended INSIDE it.
    // Its top is therefore not a stable content anchor. Prefer a visible text
    // message so expanding that bundle cannot push the reader's text downward.
    const stableMessages = visibleMessages.filter((message) => !message.classList.contains("kind-tool"));
    const candidates = stableMessages.length ? stableMessages : visibleMessages;
    const visibleMessage = candidates.find((message) => message.getBoundingClientRect().top >= containerRect.top + 8)
      ?? candidates[0];
    // Tool calls are regrouped when an older page joins the same turn. Their
    // bundle key can disappear even though nearby agent/user messages survive.
    const fallbackMessage = [...container.querySelectorAll<HTMLElement>("[data-message-key]:not(.kind-tool)")]
      .find((message) => message.getBoundingClientRect().top >= (visibleMessage?.getBoundingClientRect().top ?? containerRect.top) - 1);
    const visibleRow = visibleMessage?.closest<HTMLElement>(selector)
      ?? visibleRows.find((row) => row.dataset.rowKey?.startsWith("turn:"))
      ?? visibleRows[0];
    if (!visibleRow?.dataset.rowKey) return;
    flowAnchorRef.current = {
      key: visibleRow.dataset.rowKey,
      offset: visibleRow.getBoundingClientRect().top - containerRect.top,
      messageKey: visibleMessage?.dataset.messageKey,
      messageOffset: visibleMessage ? visibleMessage.getBoundingClientRect().top - containerRect.top : undefined,
      fallbackMessageKey: fallbackMessage?.dataset.messageKey,
      fallbackMessageOffset: fallbackMessage ? fallbackMessage.getBoundingClientRect().top - containerRect.top : undefined,
      scrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight,
      threadKey
    };
  }

  function restoreCapturedAnchor(container: HTMLElement, anchor: NonNullable<typeof flowAnchorRef.current>): void {
    const message = anchor.messageKey
      ? container.querySelector<HTMLElement>(`[data-message-key="${CSS.escape(anchor.messageKey)}"]`)
      : null;
    const fallback = !message && anchor.fallbackMessageKey
      ? container.querySelector<HTMLElement>(`[data-message-key="${CSS.escape(anchor.fallbackMessageKey)}"]`)
      : null;
    const row = !message && !fallback && !anchor.messageKey
      ? container.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(anchor.key)}"]`)
      : null;
    const target = message || fallback || row;
    const targetOffset = message ? anchor.messageOffset ?? anchor.offset
      : fallback ? anchor.fallbackMessageOffset ?? anchor.offset : anchor.offset;
    const nextTop = target
      ? container.scrollTop + target.getBoundingClientRect().top - container.getBoundingClientRect().top - targetOffset
      : anchor.scrollTop + Math.max(0, container.scrollHeight - anchor.scrollHeight);
    if (Math.abs(nextTop - container.scrollTop) < 0.5) return;
    flowAnchorApplyingRef.current = true;
    container.scrollTop = Math.max(0, nextTop);
    flowAnchorApplyingRef.current = false;
  }

  const virtualizer = useVirtualizer({
    count: useFlowLayout ? 0 : rows.length,
    getScrollElement: () => useFlowLayout ? null : scrollElementRef.current,
    // The history control is only one line tall. A 260px estimate here leaves
    // a visible empty band above the oldest message until it is measured.
    estimateSize: (index) => index === 0 ? 44 : 260,
    getItemKey: (index) => rowsRef.current[index]?.key ?? index,
    // Keep a small runway around the viewport; rendering every loaded turn
    // defeats pagination once a reader has scrolled through many pages.
    overscan: 12,
    useAnimationFrameWithResizeObserver: false,
    // Bottom-following belongs to the parent scrollport, which includes the
    // composer clearance. The virtualizer's item-end target does not, and the
    // two different targets used to pull the viewport back and forth.
    anchorTo: "start",
    followOnAppend: false,
    scrollEndThreshold: 120,
    isScrollingResetDelay: 500,
    useScrollendEvent: true,
    enabled: !useFlowLayout
  });
  // Only passive history reading needs the virtualizer's size compensation.
  // Following, explicit navigation and prepending each have their own target.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => (
    !flowAnchorRef.current && scrollMotionFrameRef.current === null && !shouldFollowEnd?.()
    && item.end <= (instance.scrollOffset ?? 0)
  );

  useLayoutEffect(() => {
    // The DOM scrollport is reused for the next conversation. A smooth-scroll
    // completion from the previous one must never act on the new thread.
    cancelSmoothEnd();
    if (flowAnchorRef.current?.threadKey !== threadKey) releaseHistoryAnchor();
  }, [threadKey]);

  useLayoutEffect(() => {
    if (!useFlowLayout) virtualizer.measure();
  }, [threadKey, useFlowLayout, virtualizer]);

  useLayoutEffect(() => {
    const container = scrollElementRef.current;
    if (!container || flowAnchorRef.current || scrollMotionFrameRef.current !== null || !shouldFollowEnd?.()) return;
    // Commit the measured content height and its bottom position in the same
    // paint. A delayed rAF here exposes an older answer for one frame.
    const end = Math.max(0, container.scrollHeight - container.clientHeight);
    if (Math.abs(container.scrollTop - end) > 1) container.scrollTop = end;
  });

  useImperativeHandle(forwardedRef, () => ({
    cancelScroll() {
      releaseHistoryAnchor();
      cancelSmoothEnd();
    },
    scrollToKey(key, align = "auto") {
      releaseHistoryAnchor();
      cancelSmoothEnd();
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
      const offset = virtualizer.getOffsetForIndex(index, align)?.[0];
      if (offset === undefined || !scrollElementRef.current) return false;
      // Avoid the library's multi-frame index reconciliation: it can survive
      // a subsequent bottom/search navigation and pull back to this old index.
      scrollElementRef.current.scrollTo({ top: offset, behavior: "auto" });
      return true;
    },
    scrollToEnd(behavior = "auto") {
      const container = scrollElementRef.current;
      if (!container) return;
      releaseHistoryAnchor();
      if (behavior === "smooth") {
        cancelSmoothEnd();
        const start = container.scrollTop;
        const startedAt = performance.now();
        const duration = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 420;
        const step = (now: number) => {
          const progress = duration ? Math.min(1, (now - startedAt) / duration) : 1;
          const end = Math.max(0, container.scrollHeight - container.clientHeight);
          container.scrollTop = start + (end - start) * (1 - (1 - progress) ** 4);
          scrollMotionFrameRef.current = progress < 1 ? window.requestAnimationFrame(step) : null;
        };
        scrollMotionFrameRef.current = window.requestAnimationFrame(step);
        return;
      }
      // A composer/content ResizeObserver can fire during the browser's
      // smooth scroll. Do not interrupt that animation with an auto jump.
      if (scrollMotionFrameRef.current !== null) return;
      // The floating composer reserves dynamic padding inside this scrollport.
      // The virtualizer's item-end offset excludes that padding, so use the
      // browser's actual scroll height for both layout modes.
      if (container.scrollHeight - container.scrollTop - container.clientHeight < 1) return;
      container.scrollTo({ top: container.scrollHeight, behavior });
    },
    isAtEnd(threshold = 120) {
      const container = scrollElementRef.current;
      return Boolean(container && container.scrollHeight - container.scrollTop - container.clientHeight <= threshold);
    },
    measure() {
      if (!useFlowLayout) virtualizer.measure();
    },
    captureHistoryAnchor() {
      cancelSmoothEnd();
      releaseHistoryAnchor();
      captureVisibleAnchor();
      if (flowAnchorRef.current) {
        scrollElementRef.current?.style.setProperty("overflow-anchor", "none");
      }
    }
  }), [threadKey, useFlowLayout, virtualizer]);

  useLayoutEffect(() => {
    if (!useFlowLayout || !flowAnchorRef.current) return;
    const container = scrollElementRef.current;
    if (!container) return;
    if (flowAnchorRef.current.threadKey !== threadKey) {
      flowAnchorRef.current = null;
      return;
    }
    historyAnchorRestoringRef.current = true;

    const restore = () => {
      const anchor = flowAnchorRef.current;
      if (!anchor) return;
      restoreCapturedAnchor(container, anchor);
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
      historyAnchorRestoringRef.current = false;
      container.style.removeProperty("overflow-anchor");
    }, 1_500);
    flowAnchorCleanupRef.current = () => {
      observer?.disconnect();
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      historyAnchorRestoringRef.current = false;
      container.style.removeProperty("overflow-anchor");
    };
    return flowAnchorCleanupRef.current;
  }, [historyRevision, rowSignature, threadKey, useFlowLayout]);

  useLayoutEffect(() => {
    if (useFlowLayout || !flowAnchorRef.current) return;
    const container = scrollElementRef.current;
    const anchor = flowAnchorRef.current;
    if (!container || anchor.threadKey !== threadKey) {
      flowAnchorRef.current = null;
      return;
    }
    const index = rowsRef.current.findIndex((row) => row.key === anchor.key);
    if (index < 0) {
      flowAnchorRef.current = null;
      return;
    }

    // Restore the old visible row before paint, rather than showing the newly
    // prepended page at the same numeric scrollTop.
    const estimatedStart = virtualizer.getOffsetForIndex(index, "start")?.[0];
    if (estimatedStart !== undefined) container.scrollTop = Math.max(0, estimatedStart - anchor.offset);
    historyAnchorRestoringRef.current = true;
    const restore = () => {
      if (flowAnchorRef.current !== anchor) return;
      restoreCapturedAnchor(container, anchor);
    };
    restore();
    let secondFrame = 0;
    const frame = window.requestAnimationFrame(() => { secondFrame = window.requestAnimationFrame(restore); });
    const sizer = container.querySelector<HTMLElement>(".virtualConversationSizer");
    const observer = sizer ? new ResizeObserver(restore) : null;
    if (sizer) observer?.observe(sizer);
    const timer = window.setTimeout(() => {
      restore();
      observer?.disconnect();
      flowAnchorRef.current = null;
      historyAnchorRestoringRef.current = false;
      container.style.removeProperty("overflow-anchor");
    }, 650);
    flowAnchorCleanupRef.current = () => {
      observer?.disconnect();
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(secondFrame);
      window.clearTimeout(timer);
      container.style.removeProperty("overflow-anchor");
      historyAnchorRestoringRef.current = false;
    };
    return flowAnchorCleanupRef.current;
  }, [historyRevision, rowSignature, threadKey, useFlowLayout, virtualizer]);

  useLayoutEffect(() => () => {
    releaseHistoryAnchor();
    cancelSmoothEnd();
  }, []);

  const virtualItems = virtualizer.getVirtualItems();
  return (
    <div
      {...containerProps}
      className={[className, useFlowLayout ? "virtualConversationFlowMode" : "virtualConversationVirtualMode"].filter(Boolean).join(" ")}
      onScroll={onScroll}
      onScrollCapture={(event) => {
        containerProps.onScrollCapture?.(event);
        if (flowAnchorRef.current && !flowAnchorApplyingRef.current && !historyAnchorRestoringRef.current) captureVisibleAnchor();
      }}
      onWheel={(event) => {
        // Keep the anchor alive through inertial wheel events while the new
        // page is being measured; cancelling here reintroduced top-of-page jumps.
        cancelSmoothEnd();
        if (event.deltaY > 0 && historyAnchorRestoringRef.current) releaseHistoryAnchor();
        onWheel?.(event);
      }}
      onTouchStart={(event) => {
        cancelSmoothEnd();
        if (historyAnchorRestoringRef.current) releaseHistoryAnchor();
        onTouchStart?.(event);
      }}
      onTouchMove={(event) => {
        cancelSmoothEnd();
        onTouchMove?.(event);
      }}
      onPointerDown={(event) => {
        cancelSmoothEnd();
        if (historyAnchorRestoringRef.current) releaseHistoryAnchor();
        onPointerDown?.(event);
      }}
      onKeyDown={(event) => {
        if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
          cancelSmoothEnd();
          releaseHistoryAnchor();
        }
        onKeyDown?.(event);
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
