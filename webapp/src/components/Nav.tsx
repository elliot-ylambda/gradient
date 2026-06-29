"use client";

import { useEffect, useState } from "react";

const REPO = "https://github.com/elliot-ylambda/gradient";

export function Nav() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <nav className={`nav ${scrolled ? "scrolled" : ""}`}>
      <div className="wrap nav-inner">
        <a className="wordmark" href="#top" aria-label="gradient — home">
          <span className="mark" aria-hidden="true" />
          gradient
        </a>
        <div className="nav-links">
          <a className="hide-sm" href="#how">
            How it works
          </a>
          <a className="hide-sm" href="#generates">
            Output
          </a>
          <a href={REPO}>GitHub</a>
          <a className="nav-cta" href="#install">
            Install
          </a>
        </div>
      </div>
    </nav>
  );
}
