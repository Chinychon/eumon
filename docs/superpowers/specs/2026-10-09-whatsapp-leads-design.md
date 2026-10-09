# WhatsApp leads, stage 1: reference codes and outcomes

**Status:** built on 2026-10-09 ("how would we do WhatsApp Business" → stage 1).

**Goal:** count what WhatsApp enquiries become (chats, qualified leads, customers, their value) and which pages produce them, without WhatsApp's API, so it works for businesses on the ordinary WhatsApp Business app.

## How it works

1. When a visitor taps a WhatsApp link (an Eumon CTA, or any `wa.me` / `api.whatsapp.com` link on a site with the tracking snippet), the browser writes a fresh code into the pre-filled message: `Hi, I would like to ask about Braces (ref K7M2Q)`. A link with its own message keeps it; the opening line is in the page language. Group invites (`chat.whatsapp.com`) can't carry a message and get no code.
2. The click's beacon or event carries the code, and the server starts a lead (`leads`, migration 0021) tied to the visitor's session, so to the Eumon page they first landed on and where they came from.
3. Staff paste the message (or type the code) under Dashboard → Enquiries → Match a chat, and mark the lead: chat started, qualified, customer (with its value), or lost. Enquiries without a code can be added by hand.
4. Outcomes go into the ledger per day and show in "From enquiry to customer": 28-day counts and value, chats and customers per week, and leads, customers and value by page type over 90 days. The client link shows this card; the desk is operator-only.

Values are in one currency per site (Setup → On your site → Currency).

## Privacy

No phone number, name or message is stored: only the code, the session the click came from, the page, and what staff mark.

## Next (stage 2)

Matching automatically through the WhatsApp Cloud API (Meta's Embedded Signup, or a provider such as WATI, respond.io or Twilio): incoming messages arrive as webhooks and the code links them without staff, with a suggested qualification from the first message. The growth plan can then weight page types by customers and value.
