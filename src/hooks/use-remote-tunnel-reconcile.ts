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
 * 必须挂在一个**永不卸载**的宿主上（helix-layout）：远程列表本身在侧边栏里可
 * 折叠、在输入框项目下拉里只在展开时挂载，那些位置随时会卸载。只靠它们回灌的
 * 话 `remoteMode` 会停在 null —— 文件树 / git 芯片于是显示本地目录，而 agent
 * 其实在远端跑。
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
    // 全局单一开关：本地 fs/git 驱动的界面（文件树、git 芯片、@ 候选）全靠它
    // 判断「现在是不是在本地」。读到 null 就照旧渲染；读到非 null 就知道自己
    // 显示的东西与 agent 实际工作目录无关，必须让位。
    setRemoteMode(
      matched
        ? {
            label: remoteProjectLabel(matched),
            host: matched.host,
            username: matched.username,
            // 远端目录以后端为准（它读的是真正生效的 pi.remote_cwd），
            // 会话分组键 remote://<id>/<路径> 依赖这个值。
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
