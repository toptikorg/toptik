"use client";

import { useEffect } from 'react';
import { mountMobileStoreBar } from './mobile-store-bar';
import styles from './MobileStoreBar.module.css';

export function MobileStoreBar({ page }: { page: 'article' | 'carousel' }) {
  useEffect(() => {
    const root = document.querySelector<HTMLElement>(`[data-mobile-store-page="${page}"]`);
    if (root) return mountMobileStoreBar(root, styles.bar);
  }, [page]);
  return null;
}
