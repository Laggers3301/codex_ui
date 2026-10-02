import { useEffect, useRef, useState, type ReactNode } from "react";
import { Minus, Plus } from "lucide-react";

export function PreviewZoom({ children, frame = false }: { children: ReactNode; frame?: boolean }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({width:0,height:0,contentHeight:0});
  const [zoom,setZoom] = useState(1);
  useEffect(() => {
    const stage=stageRef.current, content=contentRef.current;
    if (!stage || !content) return;
    const sync=()=>setSize(previous=>{
      const next={width:stage.clientWidth,height:stage.clientHeight,contentHeight:content.offsetHeight};
      return JSON.stringify(previous)===JSON.stringify(next)?previous:next;
    });
    sync();const observer=new ResizeObserver(sync);observer.observe(stage);observer.observe(content);
    return ()=>observer.disconnect();
  },[]);
  return <div className="documentZoomViewer">
    <div className="documentZoomStage" ref={stageRef}>
      <div className="documentZoomExtent" style={{width:size.width*zoom,height:Math.max(size.height,size.contentHeight*zoom)}}>
        <div ref={contentRef} className="documentZoomContent" style={{width:size.width || "100%",height:frame?size.height || "100%":undefined,transform:`scale(${zoom})`}}>{children}</div>
      </div>
    </div>
    <div className="imageViewerZoomControls" role="group" aria-label="文件缩放">
      <button type="button" aria-label="缩小文件" title="缩小" onClick={()=>setZoom(value=>Math.max(.25,value/1.25))}><Minus size={17}/></button>
      <button type="button" className="imageViewerZoomValue" title="重置为适应窗口" onClick={()=>setZoom(1)}>{Math.round(zoom*100)}%</button>
      <button type="button" aria-label="放大文件" title="放大" onClick={()=>setZoom(value=>Math.min(4,value*1.25))}><Plus size={17}/></button>
    </div>
  </div>;
}
