import { MoreHorizontal } from "lucide-react";

export function Empty({ label }: { label: string }) {
  return (
    <div className="empty-state">
      <MoreHorizontal size={22} />
      <p>{label}</p>
    </div>
  );
}
