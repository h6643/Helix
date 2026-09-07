/**
 * Minimal `process` shim so legacy renderer code that reads process.env (the
 * debug logger, provider env-key lookup) degrades to `undefined` instead of
 * throwing ReferenceError in the browser. import.meta.env.MODE mirrors the old
 * `process.env.NODE_ENV` (development / production).
 *
 * `cwd` is a no-op returning '' — the renderer has no filesystem cwd (Tauri
 * runs the Rust main process, not Node). Without it, `typeof process !==
 * 'undefined' ? process.cwd() : ''` guards in session/new workDir fallbacks
 * *throw* ("process.cwd is not a function"), aborting the send before any
 * session is created → model never replies.
 */
(globalThis as any).process = {
  env: {
    NODE_ENV: import.meta.env.MODE,
  },
  cwd: () => "",
};

export {};
