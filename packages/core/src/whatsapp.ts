/*
 * WhatsApp enquiries without WhatsApp's API: every WhatsApp link on Eumon's
 * pages and on the tracked main site gets a short reference code in its
 * pre-filled message ("… (ref K7M2Q)"). The code arrives in the business's
 * chat, so staff can match a conversation to the click, the landing page and
 * the search behind it, then mark how it turned out.
 */

/** Letters and digits that can't be misread in a chat: no 0/O, 1/I. */
export const REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const REF_LENGTH = 5;

/** How a lead turned out, in order; `lost` can follow any of the others. */
export const LEAD_STATUSES = ["clicked", "chat", "qualified", "won", "lost"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  clicked: "Clicked, no chat matched", chat: "Chat started", qualified: "Qualified", won: "Customer", lost: "Lost",
};

/** wa.me and api.whatsapp.com links open a chat and carry a message; group invite links (chat.whatsapp.com) don't. */
export const isWhatsAppChatUrl = (url: string) => /^https?:\/\/(wa\.me|api\.whatsapp\.com|(www\.)?whatsapp\.com\/send)/i.test(url);

/**
 * The browser-side code, as a JavaScript source string, shared by the landing
 * pages and the main-site snippet so both write codes the same way. Defines
 * `eumonRef()` and `eumonWithRef(href, ref, hello)`, which returns the link
 * with " (ref CODE)" after its message (or `hello` when it has none), or null
 * for a link that can't carry a message.
 */
export const WHATSAPP_REF_JS = `function eumonRef(){var a="${REF_ALPHABET}",b=new Uint8Array(${REF_LENGTH}),r="";(window.crypto||{getRandomValues:function(x){for(var i=0;i<x.length;i++)x[i]=Math.floor(Math.random()*256);return x}}).getRandomValues(b);for(var i=0;i<b.length;i++)r+=a[b[i]%a.length];return r}
function eumonWithRef(h,r,t){try{var u=new URL(h),n=u.hostname.toLowerCase();if(!(n==="wa.me"||n==="api.whatsapp.com"||((n==="whatsapp.com"||n==="www.whatsapp.com")&&u.pathname.indexOf("/send")===0)))return null;var m=(u.searchParams.get("text")||"").trim()||t||"";m=m.replace(/\\s*\\(ref [A-Z0-9]{${REF_LENGTH}}\\)$/,"");u.searchParams.set("text",(m?m+" ":"")+"(ref "+r+")");return u.toString()}catch(e){return null}}`;

const CODE = new RegExp(`^[${REF_ALPHABET}]{${REF_LENGTH}}$`);

/** The code in a pasted chat message ("… (ref K7M2Q)") or typed on its own, upper-cased; null when there is none. */
export function findRef(text: string): string | null {
  const trimmed = text.trim().toUpperCase();
  if (CODE.test(trimmed)) return trimmed;
  const match = new RegExp(`\\bREF\\s*[:#-]?\\s*([${REF_ALPHABET}]{${REF_LENGTH}})\\b`).exec(trimmed);
  return match ? match[1]! : null;
}

export const isRef = (value: unknown): value is string => typeof value === "string" && CODE.test(value);

/** Leads by the kind of page the visitor first landed on, counted by how far each has got. */
export type PageTypeOutcome = { pageType: string; leads: number; chats: number; qualified: number; won: number; revenue: number };
