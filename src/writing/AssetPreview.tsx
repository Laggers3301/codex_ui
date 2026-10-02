import { useEffect, useState } from "react";
import { fetchProjectFileBlob } from "../api";
import DocumentPreview from "../DocumentPreview";

export default function AssetPreview({ projectId, path, name, localUrl }: { projectId: string; path: string; name: string; localUrl?: string }) {
  const [url, setUrl] = useState(localUrl ?? "");
  const [error, setError] = useState("");
  useEffect(() => {
    if (localUrl) { setUrl(localUrl); return; }
    let canceled = false;
    let objectUrl = "";
    setUrl(""); setError("");
    void fetchProjectFileBlob(projectId, path).then(blob => {
      if (canceled) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }).catch(caught => { if (!canceled) setError(caught instanceof Error ? caught.message : String(caught)); });
    return () => { canceled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [localUrl, projectId, path]);
  useEffect(() => () => { if (localUrl) URL.revokeObjectURL(localUrl); }, [localUrl]);
  if (error) return <div className="writingAssetPreview"><div className="writingEmpty" role="alert">{error}</div></div>;
  return <div className="writingAssetPreview">{url ? <DocumentPreview name={name} url={url} /> : <div className="writingEmpty">正在加载只读预览…</div>}</div>;
}
