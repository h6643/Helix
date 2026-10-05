/**
 * 视觉模型配置来源:Helix 的 `<helix_data_dir>/config.yaml` 里的 `vision:` 块。
 *
 * 唯一写入方是 Helix 设置页「视觉模型」(src/components/Helix/vision-model-settings.tsx
 * → src-tauri/src/vision.rs 的 vision_config_save),本模块只读不写,
 * 因此不再有 aux-vision.json 这第二份"视觉模型是哪个"的真相。
 *
 * 目录解析必须与 Rust 侧 `src-tauri/src/paths.rs::helix_data_dir` 一致,
 * 否则用户改过「数据存储路径」后两边会读到不同的 config.yaml:
 *   1) HELIX_DATA_DIR 环境变量  2) <config_dir>/helix/data_root 指针文件  3) 默认 <agentDir>/helix
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface VisionConfig {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
}

/** 调用预算:原 aux-vision.json 的可调项,现在无写入方,固定为常量。 */
export const CALL_KNOBS = {
  // 与 src-tauri/src/vision.rs 的 max_tokens 保持一致:上游 aux-vision 的 8192 会被
  // glm-4v-flash 这类小上限模型直接 400(code 1210,范围 [1,1024])拒掉。
  // 输出撞到上限时工具会在结果头部显式声明转录被截断,模型可自行收窄问题重调。
  maxOutputTokens: 1024,
  maxRetries: 2,
  maxRetryDelayMs: 5000,
};

const EMPTY: VisionConfig = { provider: "", model: "", baseUrl: "", apiKey: "" };

/** baseUrl + model 齐备才算配好;apiKey 允许为空(本地网关 / 免鉴权端点)。 */
export function isConfigured(cfg: VisionConfig): boolean {
  return Boolean(cfg.baseUrl && cfg.model);
}

export function helixDataDir(): string {
  const env = process.env.HELIX_DATA_DIR?.trim();
  if (env) return env;

  const pointer = dataRootPointerPath();
  if (pointer) {
    try {
      const p = fs.readFileSync(pointer, "utf-8").trim();
      if (p) return stripVerbatimPrefix(p);
    } catch {
      // 指针缺失/不可读:落到默认目录
    }
  }
  return path.join(getAgentDir(), "helix");
}

export function configYamlPath(): string {
  return path.join(helixDataDir(), "config.yaml");
}

/** `dirs::config_dir()` 的等价实现:mac → Library/Application Support,win → %APPDATA%,其余 → XDG。 */
function configDir(): string | undefined {
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support");
  if (process.platform === "win32") return process.env.APPDATA || path.join(home, "AppData", "Roaming");
  return process.env.XDG_CONFIG_HOME || path.join(home, ".config");
}

function dataRootPointerPath(): string | undefined {
  const base = configDir();
  return base ? path.join(base, "helix", "data_root") : undefined;
}

/** 老版本写入指针时泄漏出的 `\\?\` 前缀(Rust canonicalize 的 verbatim 形式),UNC 路径保持原样。 */
function stripVerbatimPrefix(p: string): string {
  if (p.startsWith("\\\\?\\UNC\\")) return p;
  const stripped = p.startsWith("\\\\?\\") ? p.slice(4) : p;
  return stripped.replace(/\\/g, path.sep);
}

/**
 * 取 yaml 顶层 `vision:` 块的扁平键值,与 Rust 侧 `read_yaml_block` 同语义:
 * 缩进行属于块、回到零缩进行即结束、值去引号。每次调用都重读磁盘,
 * 所以设置页改完不需要重启 pi。
 */
function readYamlBlock(yaml: string, top: string): Record<string, string> {
  const out: Record<string, string> = {};
  let inBlock = false;
  for (const line of yaml.replace(/\r\n/g, "\n").split("\n")) {
    if (!line.startsWith(" ") && !line.startsWith("\t")) {
      const isTop = line.startsWith(top) && line.slice(top.length).startsWith(":");
      if (!isTop) {
        inBlock = false;
        continue;
      }
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    const t = line.trimStart();
    if (t.startsWith("#")) continue;
    const colon = t.indexOf(":");
    if (colon < 0) continue;
    const key = t.slice(0, colon).trim();
    if (!/^[A-Za-z0-9_]+$/.test(key)) continue;
    out[key] = t.slice(colon + 1).trim().replace(/^["']+/, "").replace(/["']+$/, "");
  }
  return out;
}

export function readVisionConfig(): VisionConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(configYamlPath(), "utf-8");
  } catch {
    return { ...EMPTY };
  }
  const block = readYamlBlock(raw, "vision");
  return {
    provider: block.provider ?? "",
    model: block.model ?? "",
    baseUrl: block.baseUrl ?? "",
    apiKey: block.apiKey ?? "",
  };
}

/** 供 /vision status 展示:绝不返回 apiKey。 */
export function describeConfigSource(cfg: VisionConfig): string {
  return `${cfg.provider || "custom"}/${cfg.model || "(未配置)"} @ ${cfg.baseUrl || "(未配置)"}\nsource: ${configYamlPath()}`;
}
