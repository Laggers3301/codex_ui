import { memo, useMemo } from "react";
import {
  ArrowLeft as IpArrowLeft, ArrowRight as IpArrowRight, Browser as IpBrowser,
  Check as IpCheck, Click as IpClick, Close as IpClose, Computer as IpComputer,
  Down as IpDown, Right as IpRight, FileCode as IpFileCode, FileEditing as IpFileEditing,
  FileText as IpFileText, FolderClose as IpFolder, FolderOpen as IpFolderOpen,
  HardDisk as IpHardDisk, LayoutOne as IpLayoutOne, Link as IpLink, List as IpList,
  LoadingFour as IpLoading, More as IpMore, Pause as IpPause, PeoplesTwo as IpPeople,
  Play as IpPlay, Plus as IpPlus, ReduceOne as IpMinus, Refresh as IpRefresh,
  RightBar as IpRightBar, Target as IpTarget, Terminal as IpTerminal,
  Time as IpClock, Edit as IpEdit, Delete as IpTrash
} from "@icon-park/svg";

type Props = { size?: number; className?: string; fill?: string };

// Use the official IconPark paths and the same 48-unit, rounded 4px stroke as
// the sidebar/+ menu. Render a direct SVG so tree-label span rules cannot grow
// the glyph box or introduce extra gaps.
function iconPark(factory: typeof IpPlus, name: string) {
  return memo(function PanelIcon({ size = 16, className, fill }: Props) {
    const markup = useMemo(() => factory({ size, theme: fill && fill !== "none" ? "filled" : "outline", fill: "currentColor", strokeWidth: 4, strokeLinecap: "round", strokeLinejoin: "round" })
      .replace(/^[\s\S]*?<svg\b[^>]*>/, "").replace(/<\/svg>\s*$/, ""), [size, fill]);
    return <svg className={`panelIcon${className ? ` ${className}` : ""}`} data-iconpark={name} xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden="true" focusable="false" style={{ display: "block", flexShrink: 0 }} dangerouslySetInnerHTML={{ __html: markup }} />;
  });
}

export const ArrowLeft = iconPark(IpArrowLeft, "arrow-left");
export const ArrowRight = iconPark(IpArrowRight, "arrow-right");
export const Browser = iconPark(IpBrowser, "browser");
export const Check = iconPark(IpCheck, "check");
export const ChevronDown = iconPark(IpDown, "down");
export const ChevronRight = iconPark(IpRight, "right");
export const FileCode = iconPark(IpFileCode, "file-code");
export const FileEditing = iconPark(IpFileEditing, "file-editing");
export const FileText = iconPark(IpFileText, "file-text");
export const Folder = iconPark(IpFolder, "folder-close");
export const FolderOpen = iconPark(IpFolderOpen, "folder-open");
export const HardDrive = iconPark(IpHardDisk, "hard-disk");
export const LayoutOne = iconPark(IpLayoutOne, "layout-one");
export const Link = iconPark(IpLink, "link");
export const List = iconPark(IpList, "list");
export const LoaderCircle = iconPark(IpLoading, "loading-four");
export const Minus = iconPark(IpMinus, "reduce-one");
export const Monitor = iconPark(IpComputer, "computer");
export const MoreHorizontal = iconPark(IpMore, "more");
export const MousePointer2 = iconPark(IpClick, "click");
export const Pause = iconPark(IpPause, "pause");
export const People = iconPark(IpPeople, "peoples-two");
export const Play = iconPark(IpPlay, "play");
export const Plus = iconPark(IpPlus, "plus");
export const RefreshCcw = iconPark(IpRefresh, "refresh");
export const RotateCw = RefreshCcw;
export const RightBar = iconPark(IpRightBar, "right-bar");
export const Target = iconPark(IpTarget, "target");
export const Terminal = iconPark(IpTerminal, "terminal");
export const X = iconPark(IpClose, "close");
export const Clock = iconPark(IpClock, "time");
export const Edit = iconPark(IpEdit, "edit");
export const Trash = iconPark(IpTrash, "delete");
