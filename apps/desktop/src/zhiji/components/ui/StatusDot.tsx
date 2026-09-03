// 状态色点：根据状态映射到语义色（品牌/成功/信息/中性）。
// 用于会议列表与详情的状态提示，hover 出说明（title）。
import { statusTone } from "../../types";

export function StatusDot({ status }: { status: string }) {
  return <span className={`status-dot ${statusTone(status)}`} title={status} />;
}
