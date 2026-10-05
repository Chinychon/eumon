import type { ConversionEventName } from "@organic-growth/core";

export interface OrganicGrowthTracker {
  track(event: ConversionEventName, options?: { destination?: string }): Promise<void>;
}

/** Lightweight browser tracker; stores only a random anonymous session ID. */
export function createOrganicGrowthTracker(input: { siteId: string; endpoint: string; sessionStorage?: Storage }): OrganicGrowthTracker {
  const endpoint = input.endpoint.replace(/\/$/, "");
  const storage = input.sessionStorage ?? (typeof window !== "undefined" ? window.sessionStorage : undefined);
  let sessionId = "";
  try {
    sessionId = storage?.getItem(`og-session-${input.siteId}`) ?? "";
    if (!sessionId) {
      sessionId = crypto.randomUUID().replaceAll("-", "");
      storage?.setItem(`og-session-${input.siteId}`, sessionId);
    }
  } catch { sessionId = crypto.randomUUID().replaceAll("-", ""); }
  return {
    async track(event, options = {}) {
      if (typeof window === "undefined") return;
      try {
        await fetch(`${endpoint}/${encodeURIComponent(input.siteId)}/events`, {
          method: "POST", mode: "cors", keepalive: true,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ event, destination: options.destination, pageUrl: window.location.href, sessionId }),
        });
      } catch { /* analytics failures must not affect the host application */ }
    },
  };
}
