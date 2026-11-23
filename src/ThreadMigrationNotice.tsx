import { X } from "./PanelIcons";

export interface MigrationNotice {
  text: string;
  historySourceUrl?: string;
  warnings?: string[];
}

export function ThreadMigrationNotice({ notice, onDismiss }: { notice?: MigrationNotice; onDismiss(): void }) {
  if (!notice) return null;
  return <div className="branchToolArchive threadMigrationNotice uiGlassSurface" role="status" aria-label="会话迁移提示">
    <div><span>{notice.text}</span>{notice.warnings?.length ? <details><summary>迁移说明</summary>{notice.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</details> : null}</div>
    {notice.historySourceUrl ? <a href={notice.historySourceUrl}>下载完整源记录</a> : null}
    <button type="button" aria-label="关闭会话迁移提示" onClick={onDismiss}><X size={14} /></button>
  </div>;
}
