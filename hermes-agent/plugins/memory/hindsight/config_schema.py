"""Hindsight 的声明式配置面板 — 由通用桌面面板渲染。"""

from plugins.memory.config_schema import (
    KIND_SECRET,
    KIND_SELECT,
    KIND_TEXT,
    ProviderConfigSchema,
    ProviderField,
    ProviderFieldOption,
)

CONFIG_SCHEMA = ProviderConfigSchema(
    name="hindsight",
    label="Hindsight",
    fields=(
        ProviderField(
            key="mode",
            label="连接方式",
            kind=KIND_SELECT,
            default="cloud",
            description="Hermes 如何连接 Hindsight。",
            options=(
                ProviderFieldOption(
                    "cloud",
                    "云端",
                    "Hindsight Cloud API（轻量，只需要一个 API Key）",
                ),
                ProviderFieldOption(
                    "local_external",
                    "本地外部",
                    "连接已有的 Hindsight 实例",
                ),
            ),
            inline=True,
        ),
        ProviderField(
            key="api_key",
            label="API Key",
            kind=KIND_SECRET,
            env_key="HINDSIGHT_API_KEY",
            description="用于向 Hindsight API 进行身份验证。",
            placeholder="输入 Hindsight API Key",
            inline=True,
        ),
        ProviderField(
            key="api_url",
            label="API 地址",
            kind=KIND_TEXT,
            default="https://api.hindsight.vectorize.io",
            aliases=("apiUrl",),
            env_fallbacks=("HINDSIGHT_API_URL",),
            inline=True,
        ),
        ProviderField(
            key="bank_id",
            label="存储库 ID",
            kind=KIND_TEXT,
            default="hermes",
            aliases=("bankId",),
            inline=True,
        ),
        ProviderField(
            key="recall_budget",
            label="召回预算",
            kind=KIND_SELECT,
            default="mid",
            aliases=("budget",),
            options=(
                ProviderFieldOption("low", "低"),
                ProviderFieldOption("mid", "中"),
                ProviderFieldOption("high", "高"),
            ),
            inline=True,
        ),
    ),
)
