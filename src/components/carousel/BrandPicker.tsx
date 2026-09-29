"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { BrandKey, GalleryBrand } from "@/lib/carousel/brands";
import styles from "./BrandPicker.module.css";

interface BrandPickerProps {
  brands: GalleryBrand[];
  value: BrandKey;
  onChange: (value: BrandKey) => void;
  disabled?: boolean;
}

/** A disclosure, not an OS select popup. Native buttons keep touch and keyboard activation. */
export default function BrandPicker({ brands, value, onChange, disabled = false }: BrandPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const initialFocusRef = useRef(0);
  const panelId = useId();
  const options = [{ key: "all", label: "כל המותגים" }, ...brands];
  const selectedIndex = Math.max(0, options.findIndex(brand => brand.key === value));
  const label = options[selectedIndex].label;
  const expanded = isOpen && !disabled;

  useEffect(() => {
    if (!expanded) return;
    optionRefs.current[initialFocusRef.current]?.focus();
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        // Do not steal focus from the link or other control the visitor just selected.
        setIsOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
  }, [expanded]);

  function openAt(index: number) {
    if (disabled) return;
    initialFocusRef.current = index;
    if (expanded) optionRefs.current[index]?.focus();
    else setIsOpen(true);
  }

  function closeAndRestoreFocus() {
    setIsOpen(false);
    triggerRef.current?.focus();
  }

  function onOptionKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    if (event.key === "ArrowDown") next = (index + 1) % options.length;
    else if (event.key === "ArrowUp") next = (index - 1 + options.length) % options.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = options.length - 1;
    else return;
    event.preventDefault();
    optionRefs.current[next]?.focus();
  }

  return (
    <div
      ref={rootRef}
      className={styles.root}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) setIsOpen(false);
      }}
      onKeyDown={event => {
        if (expanded && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          closeAndRestoreFocus();
        }
      }}
    >
      <span className={`brand-wordmark ${styles.wordmark}`} aria-hidden="true">{label}</span>
      <button
        ref={triggerRef}
        className={styles.trigger}
        type="button"
        aria-label={`בחרו מותג: ${label}`}
        aria-describedby="carousel-brand-help"
        aria-expanded={expanded}
        aria-controls={panelId}
        disabled={disabled}
        onClick={() => expanded ? closeAndRestoreFocus() : openAt(selectedIndex)}
        onKeyDown={event => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            openAt(event.key === "ArrowDown" ? 0 : options.length - 1);
          }
        }}
      />
      <div id={panelId} className={styles.panel} role="group" aria-label="בחירת מותג" hidden={!expanded}>
        {options.map((brand, index) => (
          <button
            key={brand.key}
            ref={element => { optionRefs.current[index] = element; }}
            type="button"
            className={styles.option}
            aria-pressed={brand.key === value}
            disabled={disabled}
            onKeyDown={event => onOptionKeyDown(event, index)}
            onClick={() => {
              closeAndRestoreFocus();
              onChange(brand.key);
            }}
          >
            <span className={styles.check} aria-hidden="true">{brand.key === value ? "✓" : ""}</span>
            <bdi>{brand.label}</bdi>
          </button>
        ))}
      </div>
    </div>
  );
}
