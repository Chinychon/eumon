import type { ConversionEventName } from "@organic-growth/core";

export interface OrganicGrowthTracker {
  track(event: ConversionEventName, options?: { destination?: string }): Promise<void>;
}

/** Session ID set by Eumon landing pages, shared so conversions attribute to the page a visitor landed on. */
function landingSessionId(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(/(?:^|; )eumon_sid=([a-zA-Z0-9_-]{16,64})/);
  return match?.[1] ?? null;
}

/** Lightweight browser tracker; stores only a random anonymous session ID. */
export function createOrganicGrowthTracker(input: { siteId: string; endpoint: string; sessionStorage?: Storage }): OrganicGrowthTracker {
  const endpoint = input.endpoint.replace(/\/$/, "");
  const storage = input.sessionStorage ?? (typeof window !== "undefined" ? window.sessionStorage : undefined);
  let fallbackSessionId = "";
  try {
    fallbackSessionId = storage?.getItem(`og-session-${input.siteId}`) ?? "";
    if (!fallbackSessionId) {
      fallbackSessionId = crypto.randomUUID().replaceAll("-", "");
      storage?.setItem(`og-session-${input.siteId}`, fallbackSessionId);
    }
  } catch { fallbackSessionId = crypto.randomUUID().replaceAll("-", ""); }
  return {
    async track(event, options = {}) {
      if (typeof window === "undefined") return;
      try {
        await fetch(`${endpoint}/${encodeURIComponent(input.siteId)}/events`, {
          method: "POST", mode: "cors", keepalive: true,
          headers: { "Content-Type": "application/json" },
          // Read the landing-page cookie at send time: the visitor may arrive on a guide page after this tracker loaded.
          body: JSON.stringify({ event, destination: options.destination, pageUrl: window.location.href, sessionId: landingSessionId() ?? fallbackSessionId }),
        });
      } catch { /* analytics failures must not affect the host application */ }
    },
  };
}
