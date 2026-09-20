import type { RequestHandler } from "express";

const STREAM_PATH = /^\/api\/(?:.*\/stream|admin\/events)$/;
export function createStreamLimiter(): RequestHandler {
  const counts = new Map<string, number>();
  let total = 0;
  return (req, res, next) => {
    if (req.method !== "GET" || !STREAM_PATH.test(req.path)) return next();
    const account = req.session?.userId;
    const key = account ? `user:${account}` : `ip:${req.ip}`;
    const limit = account ? 12 : 300;
    const count = counts.get(key) ?? 0;
    if (count >= limit || total >= 1200) {
      res.setHeader("Retry-After", "15");
      res.status(429).json({ error: "Слишком много открытых потоков" });
      return;
    }
    counts.set(key, count + 1);
    total++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      total--;
      const remaining = (counts.get(key) ?? 1) - 1;
      if (remaining > 0) counts.set(key, remaining); else counts.delete(key);
    };
    res.once("close", release);
    res.once("finish", release);
    res.once("error", release);
    next();
  };
}
