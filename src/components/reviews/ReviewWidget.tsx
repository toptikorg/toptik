"use client";
import { useEffect, useRef } from 'react';
import branches from './branches.json';
import { mountReviewWidget, validReviewBranches } from './review-widget.mjs';
import './review-widget.css';

export function ReviewWidget() {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => host.current ? mountReviewWidget(host.current, branches) : undefined, []);
  if (!validReviewBranches(branches)) return null;
  return <div className="tt-review-host" ref={host} />;
}
