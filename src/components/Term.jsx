'use client';

// ---------------------------------------------------------------------------
// <Term k="PE">P/E</Term> — the plain-English tooltip (Beginner tier, §4.3).
// Wraps a jargon term with a subtle dotted underline + a small popover carrying
// its plain-English definition (from src/lib/glossary.js). Works on HOVER and on
// TAP/CLICK (mobile), is keyboard-focusable, and carries a `title` attribute as a
// no-JS / assistive fallback. An unknown key renders its children plainly — no
// underline, no crash. Dark-theme styled to match the rest of the app.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from 'react';
import { defineTerm } from '@/lib/glossary';

export default function Term(props) {
  const entry = defineTerm(props.k);
  const ref = useRef(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ left: 0, top: 0 });

  // Compute a clamped, fixed position just under the trigger so the popover never
  // clips at the viewport edge (basic but robust inside scrollable overlays).
  const place = useCallback(function () {
    var el = ref.current;
    if (!el || typeof window === 'undefined') return;
    var r = el.getBoundingClientRect();
    var W = 240;
    var margin = 8;
    var left = Math.min(Math.max(margin, r.left), window.innerWidth - W - margin);
    var top = r.bottom + 6;
    // Flip above if there isn't room below.
    if (top + 120 > window.innerHeight && r.top > 130) top = r.top - 6 - 118;
    setPos({ left: left, top: top });
  }, []);

  const show = useCallback(function () { place(); setOpen(true); }, [place]);
  const hide = useCallback(function () { setOpen(false); }, []);
  const toggle = useCallback(function (e) {
    // Tap/click: don't bubble into the parent card's onClick (e.g. openStock).
    if (e) e.stopPropagation();
    if (open) { setOpen(false); } else { place(); setOpen(true); }
  }, [open, place]);

  // While open, close on outside pointer, scroll, resize, or Escape.
  useEffect(function () {
    if (!open) return undefined;
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    function onKey(e) { if (e.key === 'Escape') setOpen(false); }
    function onMove() { setOpen(false); }
    document.addEventListener('pointerdown', onDoc, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return function () {
      document.removeEventListener('pointerdown', onDoc, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open]);

  // Unknown term → render the children plainly (no affordance, never crash).
  if (!entry) return <>{props.children != null ? props.children : (props.k || null)}</>;

  var content = props.children != null ? props.children : entry.label;

  return (
    <span
      ref={ref}
      role="button"
      tabIndex={0}
      aria-label={entry.label + ': ' + entry.plain}
      title={entry.plain}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onClick={toggle}
      onKeyDown={function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(e); }
      }}
      style={{
        borderBottom: '1px dotted #4a5568',
        cursor: 'help',
        outline: 'none',
        // keep the wrapped text visually identical to its surroundings
        display: 'inline',
      }}
    >
      {content}
      {open && (
        <span
          role="tooltip"
          onClick={function (e) { e.stopPropagation(); }}
          style={{
            position: 'fixed',
            left: pos.left,
            top: pos.top,
            width: 240,
            zIndex: 9999,
            background: '#0b0e16',
            border: '1px solid #2a3550',
            borderRadius: 8,
            padding: '8px 10px',
            fontSize: 11,
            lineHeight: 1.55,
            fontWeight: 400,
            letterSpacing: 'normal',
            color: '#c8d4e8',
            textTransform: 'none',
            fontFamily: 'Inter,sans-serif',
            boxShadow: '0 6px 20px rgba(0,0,0,.55)',
            whiteSpace: 'normal',
            textAlign: 'left',
            pointerEvents: 'auto',
          }}
        >
          <span style={{ display: 'block', fontSize: 10, fontWeight: 600, color: '#8899b4', marginBottom: 3, fontFamily: 'IBM Plex Mono,monospace' }}>{entry.label}</span>
          {entry.plain}
        </span>
      )}
    </span>
  );
}
