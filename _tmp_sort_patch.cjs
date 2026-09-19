#!/usr/bin/env node
const fs = require("fs");
const p = "src/components/Helix/api-settings.tsx";
let s = fs.readFileSync(p, "utf8");

const marker = "{availableModels.map((model) => (\n";
const i = s.indexOf(marker);
if (i === -1) { console.error("marker not found"); process.exit(1); }
const closeMarker = "\n                              ))}\n";
const j = s.indexOf(closeMarker, i);
if (j === -1) { console.error("close marker not found"); process.exit(1); }
const oldBlock = s.slice(i, j + closeMarker.length);

const newBlock = [
  "{sortedModelOptions.length === 0 ? (",
  "                                <p className=\"px-3 py-2 text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/60\">",
  "                                  无匹配模型",
  "                                </p>",
  "                              ) : (",
  "                                sortedModelOptions.map((model) => (",
  "                                  <button",
  "                                    key={model}",
  "                                    type=\"button\"",
  "                                    onClick={() => {",
  "                                      const metadata = piModels.find(",
  "                                        (m) =>",
  "                                          m.id === model &&",
  "                                          m.provider ===",
  "                                            localConfig.provider",
  "                                              .trim()",
  "                                              .replace(/^custom:/, \"\"),",
  "                                      );",
  "                                      setLocalConfig((prev) => ({",
  "                                        ...prev,",
  "                                        model,",
  "                                        contextWindow: metadata?.contextWindow,",
  "                                      }));",
  "                                      setShowModelDropdown(false);",
  "                                      setModelSearch(\"\");",
  "                                    }}",
  "                                    className={`w-full text-left px-3 py-2 rounded-md text-[length:var(--helix-transcript-size)] font-mono transition-colors ${",
  "                                      localConfig.model === model",
  "                                        ? \"bg-primary/10 text-primary\"",
  "                                      : \"text-foreground/70 hover:bg-muted\"",
  "                                    }`}",
  "                                  >",
  "                                    {model}",
  "                                  </button>",
  "                                ))",
  "                              )}",
].join("\n");

s = s.replace(oldBlock, newBlock);

const anchor = "                              {sortedModelOptions.length === 0 ? (\n";
if (s.indexOf(anchor) === -1) { console.error("anchor2 not found"); process.exit(1); }

const toolbar = [
  "                              {availableModels.length > 1 && (",
  "                                <div className=\"flex items-center gap-1 px-1 py-1 mb-1 sticky top-0 bg-card\">",
  "                                  <input",
  "                                    type=\"text\"",
  "                                    value={modelSearch}",
  "                                    onChange={(e) => setModelSearch(e.target.value)}",
  "                                    placeholder=\"筛选模型…\"",
  "                                    className=\"flex-1 px-2 py-1 text-[calc(var(--helix-transcript-size)*0.8571)] bg-muted/50 border border-border/50 rounded-md ui-text text-foreground placeholder:text-muted-foreground/40\"",
  "                                  />",
  "                                  {([\"asc\", \"desc\"] as const).map((dir) => (",
  "                                    <button",
  "                                      key={dir}",
  "                                      type=\"button\"",
  "                                      onClick={() =>",
  "                                        setModelSort((prev) =>",
  "                                          prev === dir ? \"none\" : dir",
  "                                        )",
  "                                      }",
  "                                      title={dir === \"asc\" ? \"升序（A→Z）\" : \"降序（Z→A）\"}",
  "                                      className={`px-1.5 py-1 rounded-md text-[calc(var(--helix-transcript-size)*0.8571)] border transition-colors ${",
  "                                        modelSort === dir",
  "                                          ? \"border-primary/50 text-primary bg-primary/10\"",
  "                                        : \"border-border/50 text-muted-foreground hover:bg-muted\"",
  "                                      }`}",
  "                                    >",
  "                                      {dir === \"asc\" ? \"A→Z\" : \"Z→A\"}",
  "                                    </button>",
  "                                  ))}",
  "                                  {modelSort !== \"none\" && (",
  "                                    <button",
  "                                      type=\"button\"",
  "                                      onClick={() => setModelSort(\"none\")}",
  "                                      title=\"取消排序，按默认顺序\"",
  "                                      className=\"px-1.5 py-1 rounded-md text-[calc(var(--helix-transcript-size)*0.8571)] border border-border/50 text-muted-foreground hover:bg-muted transition-colors\"",
  "                                    >",
  "                                      ×",
  "                                    </button>",
  "                                  )}",
  "                                </div>",
  "                              )}",
  "                              {sortedModelOptions.length === 0 ? (\n",
].join("\n");

s = s.replace(anchor, toolbar);

fs.writeFileSync(p, s);
console.log("OK");
