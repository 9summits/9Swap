import React from "react";
import { Button } from "../ds/components/Button";
import { Input } from "../ds/components/Input";
import { Select } from "../ds/components/Select";

// <FeedbackWidget> — a discreet floating "Feedback" pill anchored bottom-right of
// the interactive dApp. Clicking it opens a small panel with a mini-form (type /
// message / contact) that POSTs straight to a Google Form — no backend.
//
// The Google Form endpoint is CORS-locked, so the POST is fire-and-forget with
// mode:"no-cors": the response is opaque and we CANNOT read status. We show an
// optimistic thank-you, then auto-close + reset after ~2s. A network-level
// rejection (offline) is the only observable failure and surfaces an inline error
// (never a silent catch — repo rule).

// Google Form response endpoint + field entry IDs (form-specific, immutable).
const FORM_URL =
  "https://docs.google.com/forms/d/e/1FAIpQLScO8rs11I3o3fYc7gnsWlTU9YCdbhJwJOG4DjFOsxOFZAScZQ/formResponse";
const ENTRY_TYPE = "entry.437987086";
const ENTRY_MESSAGE = "entry.94826288";
const ENTRY_CONTACT = "entry.224680442";

// Exactly the three option values the form expects (value === wire value).
const TYPE_OPTIONS = [
  { value: "Bug", label: "Bug" },
  { value: "Feature request", label: "Feature request" },
  { value: "Other", label: "Other" },
];

type Status = "idle" | "sending" | "sent" | "error";

export function FeedbackWidget() {
  const [open, setOpen] = React.useState(false);
  const [type, setType] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [contact, setContact] = React.useState("");
  const [status, setStatus] = React.useState<Status>("idle");
  const [errorMsg, setErrorMsg] = React.useState("");
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const closeTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, []);

  function reset() {
    setType("");
    setMessage("");
    setContact("");
    setStatus("idle");
    setErrorMsg("");
  }

  function close() {
    setOpen(false);
  }

  // Dismiss on outside click + Escape while open (matches SettingsPopover).
  React.useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const canSend = message.trim().length > 0 && status !== "sending";

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSend) return;
    setStatus("sending");
    setErrorMsg("");

    const body = new URLSearchParams();
    body.set(ENTRY_MESSAGE, message.trim());
    if (type) body.set(ENTRY_TYPE, type);
    if (contact.trim()) body.set(ENTRY_CONTACT, contact.trim());

    fetch(FORM_URL, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    })
      .then(() => {
        // Opaque response — can't verify success. Be optimistic.
        setStatus("sent");
        if (closeTimer.current) clearTimeout(closeTimer.current);
        closeTimer.current = setTimeout(() => {
          close();
          reset();
        }, 2000);
      })
      .catch((err) => {
        // Only fires on a real network failure. Never swallow it.
        console.error("feedback submit failed:", err);
        setStatus("error");
        setErrorMsg("Couldn't send — check your connection and try again.");
      });
  }

  return (
    <div ref={rootRef} style={s.root} data-feedback-widget>
      {open && (
        <div style={s.panel} role="dialog" aria-label="Send feedback">
          <div style={s.head}>
            <span style={s.title}>Feedback</span>
            <button
              type="button"
              aria-label="Close feedback"
              onClick={close}
              style={s.closeBtn}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = "var(--text-strong)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "var(--text-tertiary)";
              }}
            >
              <XIcon />
            </button>
          </div>

          {status === "sent" ? (
            <div style={s.thanks}>
              <CheckIcon />
              <span>Thanks for the feedback!</span>
            </div>
          ) : (
            <form style={s.form} onSubmit={onSubmit}>
              <div style={s.field}>
                <label style={s.label}>Type</label>
                <Select
                  value={type}
                  onChange={setType}
                  options={TYPE_OPTIONS}
                  placeholder="Select a type"
                  size="sm"
                  style={{ display: "block", width: "100%" }}
                />
              </div>

              <div style={s.field}>
                <label style={s.label}>Message</label>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="What's on your mind?"
                  rows={4}
                  style={s.textarea}
                  onFocus={(e) => {
                    e.currentTarget.style.borderColor = "var(--border-focus)";
                  }}
                  onBlur={(e) => {
                    e.currentTarget.style.borderColor = "var(--border-default)";
                  }}
                />
              </div>

              <div style={s.field}>
                <label style={s.label}>Contact</label>
                <Input
                  value={contact}
                  onChange={(e) => setContact(e.target.value)}
                  placeholder="email or Telegram (optional)"
                />
              </div>

              {status === "error" && <div style={s.error}>{errorMsg}</div>}

              <Button
                type="submit"
                variant="primary"
                size="md"
                fullWidth
                disabled={!canSend}
                loading={status === "sending"}
              >
                Send
              </Button>
            </form>
          )}
        </div>
      )}

      <button
        type="button"
        aria-label="Send feedback"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{ ...s.fab, ...(open ? s.fabOn : null) }}
        onMouseEnter={(e) => {
          if (!open) {
            e.currentTarget.style.background = "var(--surface-frost-strong)";
            e.currentTarget.style.borderColor = "var(--border-brand)";
            e.currentTarget.style.color = "var(--text-strong)";
          }
        }}
        onMouseLeave={(e) => {
          if (!open) {
            e.currentTarget.style.background = "var(--surface-elevated)";
            e.currentTarget.style.borderColor = "var(--border-default)";
            e.currentTarget.style.color = "var(--text-secondary)";
          }
        }}
      >
        <ChatIcon />
        <span style={s.fabLabel}>Feedback</span>
      </button>
    </div>
  );
}

// Inline glyphs (Lucide-style, matching src/dapp/icons.tsx). Kept local so the
// widget stays one self-contained file.
function ChatIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flex: "none" }}
    >
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flex: "none" }}
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flex: "none", color: "var(--positive)" }}
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

const s: Record<string, React.CSSProperties> = {
  root: {
    position: "fixed",
    right: 20,
    bottom: 20,
    // Above the page content, comfortably below RainbowKit modals (~2.1e9)
    // and the token-selector modal (50) so those cover it when open.
    zIndex: 40,
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: 10,
    fontFamily: "var(--font-sans)",
  },

  fab: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    height: 38,
    padding: "0 14px",
    borderRadius: "var(--radius-pill)",
    border: "1px solid var(--border-default)",
    background: "var(--surface-elevated)",
    color: "var(--text-secondary)",
    fontFamily: "var(--font-sans)",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    boxShadow: "var(--shadow-lg)",
    transition:
      "background var(--dur-base) var(--ease-out), border-color var(--dur-base) var(--ease-out), color var(--dur-base) var(--ease-out)",
  },
  fabOn: {
    background: "var(--brand-soft)",
    borderColor: "var(--border-brand)",
    color: "var(--text-strong)",
  },
  fabLabel: { lineHeight: 1 },

  panel: {
    width: 320,
    maxWidth: "calc(100vw - 40px)",
    background: "var(--surface-elevated)",
    border: "1px solid var(--border-default)",
    borderRadius: "var(--radius-xl)",
    boxShadow: "var(--shadow-xl), var(--shadow-inset)",
    padding: 16,
  },

  head: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 14,
  },
  title: {
    fontFamily: "var(--font-display)",
    fontSize: 15,
    fontWeight: 600,
    color: "var(--text-strong)",
  },
  closeBtn: {
    display: "inline-flex",
    padding: 4,
    background: "transparent",
    border: "none",
    color: "var(--text-tertiary)",
    cursor: "pointer",
    transition: "color var(--dur-base) var(--ease-out)",
  },

  form: { display: "flex", flexDirection: "column", gap: 12 },
  field: { display: "flex", flexDirection: "column", gap: 6 },
  label: {
    fontFamily: "var(--font-sans)",
    fontSize: 12,
    fontWeight: 600,
    color: "var(--text-secondary)",
  },
  textarea: {
    width: "100%",
    minHeight: 84,
    resize: "vertical",
    padding: "10px 12px",
    background: "var(--surface-input)",
    border: "1px solid var(--border-default)",
    borderRadius: "var(--radius-md)",
    outline: "none",
    boxShadow: "none",
    color: "var(--text-strong)",
    fontFamily: "var(--font-sans)",
    fontSize: 14,
    fontWeight: 500,
    lineHeight: 1.4,
    transition: "border-color var(--dur-base) var(--ease-out)",
  },
  error: {
    fontSize: 12,
    fontWeight: 500,
    color: "var(--negative)",
    background: "var(--negative-bg)",
    border: "1px solid var(--negative-dim)",
    borderRadius: "var(--radius-sm)",
    padding: "8px 10px",
  },
  thanks: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "18px 4px 10px",
    fontSize: 14,
    fontWeight: 600,
    color: "var(--text-strong)",
  },
};
