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
 * 远程项目**不自动连接、不自动检测**：启动只检查本地项目，远程一律不动。
 * 隧道只在用户显式连接后存在于进程内（重启即消亡），所以这里只做**只读
 * 对账**——读后端 `remote_tunnel_status`（本地进程状态 + config，不碰网络）
 * 回灌 `remoteMode` 供侧边栏/徽标显示。往远端发任何探测、重连、SSH 都交给
 * 用户的显式动作（连接向导 / 服务器卡片）或发送消息时的探活门。
 *
 * 被跳过恢复的远程对话不会卡在坏状态：agent-flow-panel 会标 `remoteUnreachable`，
 * 用户连上服务器后发第一条消息即自动恢复。
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
    // 不做任何自动重连 / 远端检测（见文件头注释）：远程连接只来自用户的
    // 显式动作。
  }, [services, setRemoteMode]);

  useEffect(() => {
    if (!remoteAvailable()) return;
    void refresh();
    // 轮询只回灌本地可读的隧道进程状态（显示远程行绿/灰、更新 remoteMode）。
    // 30s 足够——连接/断开都是用户主动点的。向导连完会 bump statusVersion
    // 立刻叫醒一次。
    const t = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(t);
  }, [refresh, statusVersion]);

  return { status, refresh };
}
