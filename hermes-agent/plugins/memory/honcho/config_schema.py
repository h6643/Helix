"""Honcho 的声明式配置面板 — 由通用桌面面板渲染。"""

from plugins.memory.config_schema import (
    KIND_BOOL,
    KIND_JSON,
    KIND_NUMBER,
    KIND_SECRET,
    KIND_SELECT,
    KIND_TEXT,
    STORAGE_HONCHO_HOST_BLOCK,
    ProviderConfigSchema,
    ProviderField,
    ProviderFieldOption,
)


# 辩证（dialectic）相关下拉框共用的推理强度档位。
_REASONING_LEVELS = (
    ProviderFieldOption("minimal", "最低"),
    ProviderFieldOption("low", "低"),
    ProviderFieldOption("medium", "中"),
    ProviderFieldOption("high", "高"),
    ProviderFieldOption("max", "最高"),
)


CONFIG_SCHEMA = ProviderConfigSchema(
    name="honcho",
    label="Honcho",
    storage=STORAGE_HONCHO_HOST_BLOCK,
    docs_url="https://docs.honcho.dev/v3/guides/integrations/hermes",
    fields=(
        # — 连接 —
        ProviderField(
            key="apiKey",
            label="API Key",
            kind=KIND_SECRET,
            env_key="HONCHO_API_KEY",
            description="用于向 Honcho Cloud 进行身份验证。自建 base URL 时无需填写。",
            placeholder="输入 Honcho API Key",
            inline=True,
            group="连接",
        ),
        ProviderField(
            key="baseUrl",
            label="Base URL",
            kind=KIND_TEXT,
            aliases=("base_url",),
            env_fallbacks=("HONCHO_BASE_URL",),
            description="自建 Honcho 服务的地址。设置后覆盖环境变量。",
            placeholder="https://…（自建地址）",
            inline=True,
            group="连接",
            scope="root",
        ),
        ProviderField(
            key="environment",
            label="环境",
            kind=KIND_SELECT,
            default="production",
            env_fallbacks=("HONCHO_ENVIRONMENT",),
            description="Honcho 环境。设置了 base URL 时忽略此项。",
            options=(
                ProviderFieldOption("production", "云端"),
                ProviderFieldOption("local", "本地"),
            ),
            inline=True,
            group="连接",
        ),
        ProviderField(
            key="workspace",
            label="工作区",
            kind=KIND_TEXT,
            description="Honcho 工作区 ID。默认使用当前配置的主机名。",
            inline=True,
            group="连接",
        ),
        # — 身份 —
        ProviderField(
            key="peerName",
            label="用户 Peer 名",
            kind=KIND_TEXT,
            description="你的稳定用户 Peer。单用户场景下跨平台统一记忆。",
            placeholder="例如 eri",
            inline=True,
            group="身份",
        ),
        ProviderField(
            key="aiPeer",
            label="AI Peer 名",
            kind=KIND_TEXT,
            description="AI 侧的 Peer 名。默认使用当前配置的主机名。",
            inline=True,
            group="身份",
        ),
        # — 会话 —
        ProviderField(
            key="sessionStrategy",
            label="会话策略",
            kind=KIND_SELECT,
            default="per-directory",
            description="对话如何映射到 Honcho 会话。",
            info=(
                "按会话：每个对话使用独立的 Honcho 会话。"
                "按目录：同一工作目录的对话共享一个会话。"
                "按仓库：同一 git 仓库的对话共享一个会话。"
                "全局：所有对话共享一个会话。"
            ),
            options=(
                ProviderFieldOption("per-session", "按会话"),
                ProviderFieldOption("per-directory", "按目录"),
                ProviderFieldOption("per-repo", "按仓库"),
                ProviderFieldOption("global", "全局"),
            ),
            inline=True,
            group="会话",
        ),
        # —————— 以下为完整配置弹窗中的字段（inline=False） ——————
        # — 连接 —
        ProviderField(
            key="timeout",
            label="请求超时",
            kind=KIND_NUMBER,
            aliases=("requestTimeout",),
            env_fallbacks=("HONCHO_TIMEOUT",),
            description="Honcho HTTP 请求的超时秒数。留空使用默认值。",
            placeholder="30",
            group="连接",
            scope="root",
        ),
        # — 身份 —
        ProviderField(
            key="pinUserPeer",
            label="固定用户 Peer",
            kind=KIND_BOOL,
            default="false",
            aliases=("pinPeerName",),
            description="把用户 Peer 固定为 peer 名，忽略网关运行时的身份。单用户场景下统一记忆。",
            group="身份",
        ),
        ProviderField(
            key="runtimePeerPrefix",
            label="运行时 Peer 前缀",
            kind=KIND_TEXT,
            description="应用到未知网关运行时用户 ID 上的前缀。",
            placeholder="例如 telegram_",
            group="身份",
        ),
        ProviderField(
            key="userPeerAliases",
            label="用户 Peer 别名",
            kind=KIND_JSON,
            description="把网关运行时用户 ID 映射到稳定的 Honcho Peer。",
            placeholder='{"telegram_123": "eri"}',
            group="身份",
        ),
        # — 会话 —
        ProviderField(
            key="sessionPeerPrefix",
            label="会话 Peer 前缀",
            kind=KIND_BOOL,
            default="false",
            description="为会话 Peer 名加上主机名前缀。",
            group="会话",
        ),
        ProviderField(
            key="sessions",
            label="会话覆盖",
            kind=KIND_JSON,
            description="按解析器显式覆盖会话 ID。",
            placeholder='{"key": "session-id"}',
            group="会话",
            scope="root",
        ),
        # — 消息写入 —
        ProviderField(
            key="saveMessages",
            label="保存消息",
            kind=KIND_BOOL,
            default="true",
            description="把对话消息持久化到 Honcho。",
            group="消息写入",
        ),
        ProviderField(
            key="writeFrequency",
            label="写入频率",
            kind=KIND_TEXT,
            default="async",
            description="消息刷写时机：async、turn、session，或每 N 轮。",
            info=(
                "async：消息到达后在后台写入。"
                "turn：每轮结束后刷写。session：会话结束时刷写。"
                "数字 N：每 N 轮刷写一次。"
            ),
            placeholder="async | turn | session | N",
            group="消息写入",
        ),
        # — 辩证（Dialectic） —
        ProviderField(
            key="dialecticReasoningLevel",
            label="推理强度",
            kind=KIND_SELECT,
            default="low",
            description="辩证（peer.chat）调用的推理强度。",
            options=_REASONING_LEVELS,
            group="辩证",
        ),
        ProviderField(
            key="dialecticDynamic",
            label="动态推理",
            kind=KIND_BOOL,
            default="true",
            description="允许模型在每次调用时自行调整推理强度。",
            group="辩证",
        ),
        ProviderField(
            key="dialecticMaxChars",
            label="结果最大字符数",
            kind=KIND_NUMBER,
            description="辩证结果注入系统提示词的最大字符数。",
            placeholder="1200",
            group="辩证",
        ),
        ProviderField(
            key="dialecticDepth",
            label="轮次深度",
            kind=KIND_NUMBER,
            description="每轮辩证循环的轮数（1–3）。",
            placeholder="1",
            group="辩证",
        ),
        ProviderField(
            key="dialecticDepthLevels",
            label="每轮强度",
            kind=KIND_JSON,
            description="每一轮的推理强度；数组长度需与深度一致。",
            placeholder='["low", "medium"]',
            group="辩证",
        ),
        ProviderField(
            key="dialecticMaxInputChars",
            label="输入最大字符数",
            kind=KIND_NUMBER,
            description="发送给 peer.chat() 的查询输入的最大字符数。",
            placeholder="10000",
            group="辩证",
        ),
        # — 推理 —
        ProviderField(
            key="reasoningHeuristic",
            label="推理启发式",
            kind=KIND_BOOL,
            default="true",
            description="查询较长时自动上调推理强度。",
            group="推理",
        ),
        ProviderField(
            key="reasoningLevelCap",
            label="推理强度上限",
            kind=KIND_SELECT,
            default="high",
            description="启发式选择推理强度的上限。",
            options=_REASONING_LEVELS,
            group="推理",
        ),
        # — 召回 —
        ProviderField(
            key="recallMode",
            label="召回模式",
            kind=KIND_SELECT,
            default="hybrid",
            description="记忆检索方式：混合、仅上下文、或仅工具。",
            info=(
                "混合：自动注入上下文，外加按需的记忆工具。"
                "仅上下文：只注入，不提供工具。"
                "仅工具：模型显式查询记忆，不自动注入。"
            ),
            options=(
                ProviderFieldOption("hybrid", "混合"),
                ProviderFieldOption("context", "仅上下文"),
                ProviderFieldOption("tools", "仅工具"),
            ),
            group="召回",
        ),
        ProviderField(
            key="contextTokens",
            label="上下文 Token 上限",
            kind=KIND_NUMBER,
            description="自动注入的上下文 Token 上限。留空不设上限。",
            placeholder="（不设上限）",
            group="召回",
        ),
        ProviderField(
            key="initOnSessionStart",
            label="会话启动即初始化",
            kind=KIND_BOOL,
            default="false",
            description="在工具模式下会话开始时就初始化，而不是等第一次工具调用。",
            group="召回",
        ),
        # — 限制 —
        ProviderField(
            key="messageMaxChars",
            label="消息最大字符数",
            kind=KIND_NUMBER,
            description="发送给 Honcho 的每条消息的最大字符数。",
            placeholder="25000",
            group="限制",
        ),
        # — 观测 —
        ProviderField(
            key="observationMode",
            label="观测模式",
            kind=KIND_SELECT,
            default="directional",
            description="按 Peer 的观测预设。Directional 分别观测各方向；unified 共享同一视图。",
            options=(
                ProviderFieldOption("directional", "定向观测"),
                ProviderFieldOption("unified", "统一视图"),
            ),
            group="观测",
        ),
    ),
)
