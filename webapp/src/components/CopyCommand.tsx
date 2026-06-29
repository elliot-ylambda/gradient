"use client";

import { useState } from "react";

export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard blocked (e.g. insecure context) — leave the command visible to select manually.
    }
  }

  return (
    <button
      type="button"
      className="cmd"
      onClick={copy}
      aria-label={copied ? "Command copied" : `Copy: ${command}`}
    >
      <span>
        <span className="prompt">$ </span>
        {command}
      </span>
      <span className={`copy ${copied ? "copied" : ""}`} aria-hidden="true">
        {copied ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path
              d="M20 6 9 17l-5-5"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <rect
              x="9"
              y="9"
              width="11"
              height="11"
              rx="2.5"
              stroke="currentColor"
              strokeWidth="1.8"
            />
            <path
              d="M5 15V5.5A1.5 1.5 0 0 1 6.5 4H15"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        )}
      </span>
    </button>
  );
}
