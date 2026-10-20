import { cloneElement, isValidElement, type ReactNode } from "react";

/** remark appends one terminal LF. Typography spans must not prevent us
 * removing that synthetic line while preserving authored blank lines. */
export function trimCodeTerminalLineFeed(node: ReactNode): ReactNode {
  if (typeof node === "string") return node.replace(/\n$/, "");
  if (Array.isArray(node)) {
    if (!node.length) return node;
    return [...node.slice(0, -1), trimCodeTerminalLineFeed(node.at(-1))];
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return cloneElement(node, { children: trimCodeTerminalLineFeed(node.props.children) });
  }
  return node;
}
