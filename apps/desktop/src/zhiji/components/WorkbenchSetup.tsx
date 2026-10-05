import { ArrowUpRight, ShieldCheck } from "lucide-react";

export function WorkbenchSetup({ aiReady, transcriptionReady, onSettings }: {
  aiReady: boolean;
  transcriptionReady: boolean;
  onSettings: () => void;
}) {
  return (!aiReady || !transcriptionReady) && <section className="workbench-setup" aria-label="工作台配置状态">
      <ShieldCheck size={22} />
      <div><strong>准备好你的工作台</strong><p>本地资料库已就绪。{!transcriptionReady && "配置语音引擎后即可转写；"}{!aiReady && "连接 AI 服务后可生成纪要和周报。"}录音与手动记录可直接使用。</p></div>
      <button className="secondary-button compact-button" onClick={onSettings}>完善配置<ArrowUpRight size={14} /></button>
    </section>;
}
