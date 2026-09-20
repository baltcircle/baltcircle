import type { Request } from "express";
import { storage } from "../storage";

// SSE must not retain access for the lifetime of a TCP connection after logout,
// account deletion or session rotation. Fail closed on store/database failures.
export async function streamSessionValid(req: Request, actorId: string | undefined) {
  if (!actorId) return !req.session?.userId; // legacy public demo stream only
  try {
    await new Promise<void>((resolve, reject) => req.session.reload((err) => err ? reject(err) : resolve()));
    if (req.session.userId !== actorId) return false;
    const user = await storage.getUser(actorId);
    return !!user && !user.deletedAt && !user.blockedAt;
  } catch { return false; }
}
