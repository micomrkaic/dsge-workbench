/* engine.js — the page's side of the Cozy worker.
 *
 *     const engine = new EngineClient();
 *     await engine.start();                 // loads the WebAssembly
 *     const r = await engine.exec({src, read});
 *
 * A job that runs longer than the time limit is taken to be stuck: the
 * worker is thrown away and a fresh one started, and the job fails with a
 * message saying so.
 *
 * Part of dsge-workbench. Copyright (C) 2026 Mico Mrkaic.
 * GPL-3.0-or-later; see LICENSE. */
export class EngineClient {
  constructor(limitMs = 30000) {
    this.limit = limitMs;
    this.version = "";
    this.generation = 0;                    /* goes up each time the worker is replaced */
    this.pending = new Map();
    this.next = 1;
  }

  start() {
    this.worker = new Worker(new URL("../worker/engine-worker.js", import.meta.url));
    this.ready = new Promise((resolve, reject) => {
      this.worker.onmessage = e => {
        const d = e.data;
        if ("ready" in d) {
          if (!d.ready) return reject(new Error(d.error));
          this.version = d.version;
          return resolve(this);
        }
        const p = this.pending.get(d.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(d.id);
        p.resolve(d.result);
      };
      this.worker.onerror = e => reject(new Error(e.message || "the engine could not be loaded"));
    });
    return this.ready;
  }

  async exec(job) {
    await this.ready;
    return new Promise((resolve, reject) => {
      const id = this.next++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.restart();
        reject(new Error(`the computation took more than ${Math.round(this.limit / 1000)} seconds and was stopped`));
      }, this.limit);
      this.pending.set(id, { resolve, timer });
      this.worker.postMessage({ id, job });
    });
  }

  restart() {
    this.worker.terminate();
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.resolve({ ok: false, output: "error: the engine was restarted", values: {} }); }
    this.pending.clear();
    this.generation++;
    this.start().catch(() => {});
  }
}
