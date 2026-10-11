import { FolderOpen } from "lucide-react";
import type { ProjectWorkspace } from "./useProjectWorkspace";

export function ProjectFolder({ model }: { model: ProjectWorkspace }) {
  const { project, disabled, chooseFolder, openFolder, unlinkFolder } = model;
  return <div className="hub-project-folder" aria-label="项目资料文件夹">
    {project.folderPath
      ? <button className="secondary-button compact-button" disabled={disabled} onClick={() => void openFolder()}><FolderOpen size={14} />打开项目文件夹</button>
      : <button className="ghost-button" disabled={disabled} onClick={() => void chooseFolder()}><FolderOpen size={14} />关联项目文件夹</button>}
    {project.folderPath && <details>
      <summary>文件夹设置</summary>
      <p className="hub-path">{project.folderPath}</p>
      <div className="hub-actions"><button className="ghost-button" disabled={disabled} onClick={() => void chooseFolder()}>更换文件夹</button><button className="ghost-button" disabled={disabled} onClick={() => void unlinkFolder()}>解除文件夹关联</button></div>
      <p className="capture-hint">从此文件夹选择资料，也可关联其他位置的文件。文件夹内容需选择文件后登记。</p>
    </details>}
  </div>;
}
