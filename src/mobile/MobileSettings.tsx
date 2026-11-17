import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { MobileSheet } from "./MobileSheet";

export function MobileSettings({ label, scope, context, speed, tasks, model }: {
  mobile?: boolean; label: string; scope: string; context?: ReactNode; speed?: ReactNode; tasks?: ReactNode; model: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [scope]);
  return <>
    <button className="mobileUiModelTrigger" type="button" aria-label="会话设置" aria-expanded={open} onClick={() => setOpen(true)}><span>{label}</span><ChevronDown size={13} /></button>
    {/* keepMounted: the tasks list owns its dialog state, and the sheet closes itself the
        moment that dialog is requested. Unmounting the sheet body would discard the request. */}
    <MobileSheet title="会话设置" open={open} onClose={() => setOpen(false)} keepMounted>
      <div className="mobileUiSettingGroup">{model}</div>
      {context || speed || tasks ? <div className="mobileUiSettingGroup" onClickCapture={event => {
        // Leave modality before existing context/task dialogs open.
        if ((event.target as Element).closest('.v2ContextStatusButton,.conversationTasksTrigger')) setOpen(false);
      }}>{speed}{context}{tasks}</div> : null}
    </MobileSheet>
  </>;
}
