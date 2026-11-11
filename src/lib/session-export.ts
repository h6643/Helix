/**
 * session-export.ts — 「导出记录」的唯一通路：交给 pi 自己的导出（RPC `export_html`，
 * 等价于终端里的 `/export`）。
 *
 * pi 导出的 HTML 含工具调用、思考块与命令输出；Helix 早先自制的 JSON/Markdown
 * 序列化只剩正文，导出的文件不可复盘，那条路已整体删除。
 */
import { electronDialog, sendRpc } from "@/lib/electron-bridge";
import { isRemoteWorkDir } from "@/lib/remote-projects";
import { resolveBackendSid } from "@/lib/session-map";
import { useHelixStore } from "@/stores/helix-store";

/** 同一时刻只跑一个导出：冷会话要先恢复后端实例（几十秒级），连点会排队打转。 */
let inFlight = false;

export async function exportSessionTranscript(session: {
  id: string;
  label: string;
  workDir: string | null;
}): Promise<void> {
  if (inFlight) return;
  const st = useHelixStore.getState();
  if (isRemoteWorkDir(session.workDir)) {
    st.showToast({
      type: "error",
      title: "云端对话导不出",
      description: "记录在远端机器上，pi 写出的文件本机取不回来",
    });
    return;
  }
  const sid = await resolveBackendSid(session.id);
  if (!sid) {
    st.showToast({
      type: "error",
      title: "没有可导出的记录",
      description: "这条对话还没有后端会话文件",
    });
    return;
  }
  const fileName = `${(session.label || sid).replace(/[\\/:*?"<>|]/g, "_")}.html`;
  const dest = await electronDialog
    .saveFile({
      filters: [{ name: "HTML", extensions: ["html"] }],
      fileName,
    })
    .catch(() => null);
  if (!dest) return; // 取消
  inFlight = true;
  const toastId = st.showToast({
    type: "info",
    title: "正在导出",
    description: fileName,
    duration: 0,
  });
  try {
    const r = (await sendRpc("export_html", {
      session_id: sid,
      outputPath: dest,
    })) as { path?: unknown } | null;
    st.updateToast(toastId, {
      type: "success",
      title: "导出完成",
      description: typeof r?.path === "string" ? r.path : dest,
      duration: 10000,
    });
  } catch (e) {
    st.updateToast(toastId, {
      type: "error",
      title: "导出失败",
      description: e instanceof Error ? e.message : String(e),
      duration: 10000,
    });
  } finally {
    inFlight = false;
  }
}
