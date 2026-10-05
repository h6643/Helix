"use client";

import { useCallback, useEffect, useState } from "react";
import {
  fetchRemoteStatus,
  matchActiveRemote,
  remoteAvailable,
  remoteProjectLabel,
  type RemoteTunnelStatus,
} from "@/lib/remote-projects";
import { useHelixStore, type ExternalService } from "@/stores/helix-store";

/**
 * 远程隧道对账：查后端 `remote_tunnel_status`，把真正生效的连接状态写成全局
 * `remoteMode`。
 *
 * `remoteMode` 只描述**隧道**（后端同时只有一条）。它不描述某条对话跑在哪台机器
 * —— 那是 `session.workDir` 的事（双通道：远程对话走隧道，本地对话走本机）。
 *
 * 必须挂在一个**永不卸载**的宿主上（helix-layout）：远程列表在侧边栏里可折叠、
 * 在输入框下拉里只在展开时挂载，那些位置随时会卸载。只靠它们回灌的话
 * `remoteMode` 会停在 null —— 远程行明明连着却不绿，断开按钮也找不到。
 *
 * 可能在多处同时挂载（宿主 + 列表），各实例写的值同源于后端 status，所以幂等。
 */
export function useRemoteTunnelReconcile(services: ExternalService[]) {
  const setRemoteMode = useHelixStore((s) => s.setRemoteMode);
  const statusVersion = useHelixStore((s) => s.remoteStatusVersion);
  const [status, setStatus] = useState<RemoteTunnelStatus | null>(null);

  const refresh = useCallback(async () => {
    const s = await fetchRemoteStatus();
    setStatus(s);
    const activeId = matchActiveRemote(services, s);
    const matched = s?.connected
      ? services.find((x) => x.id === activeId)
      : undefined;
    setRemoteMode(
      matched
        ? {
            label: remoteProjectLabel(matched),
            host: matched.host,
            username: matched.username,
            // 远端目录以后端为准（它读的是真正生效的 pi.remote_cwd）：服务器行
            // 记的路径可能是旧的。
            remotePath: s?.remote_path ?? matched.remotePath,
            serviceId: matched.id,
          }
        : null,
    );
  }, [services, setRemoteMode]);

  useEffect(() => {
    if (!remoteAvailable()) return;
    void refresh();
    // 轮询：连接/断开是后端动作（还会重启 gateway），前端只能靠轮询发现。
    // 30s 足够——切换都是用户主动点的。向导连完会 bump statusVersion 立刻叫醒一次。
    const t = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(t);
  }, [refresh, statusVersion]);

  return { status, refresh };
}
