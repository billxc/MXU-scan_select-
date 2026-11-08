import { useState, useEffect } from 'react';
import { isTauri } from './paths';

export interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{
    outcome: 'accepted' | 'dismissed';
    platform: string;
  }>;
  prompt(): Promise<void>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

function notifyListeners() {
  listeners.forEach((listener) => listener());
}

/** 判断当前是否运行在 PWA 独立窗口模式（Standalone） */
export function isStandalonePwa(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    Boolean((navigator as unknown as { standalone?: boolean }).standalone)
  );
}

/** 判断是否为 iOS Safari 浏览器（不支持 beforeinstallprompt，需通过分享菜单添加到主屏幕） */
export function isIosSafari(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const isIos = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return isIos && !isTauri() && !isStandalonePwa();
}

/** 初始化 PWA：注册 Service Worker 并监听 beforeinstallprompt */
export function initPwa(): void {
  if (typeof window === 'undefined' || isTauri()) return;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    notifyListeners();
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    notifyListeners();
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }
}

/** 触发原生 PWA 安装弹窗 */
export async function promptPwaInstall(): Promise<'accepted' | 'dismissed' | 'ios-manual' | 'unavailable'> {
  if (deferredPrompt) {
    try {
      await deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      if (choice.outcome === 'accepted') {
        deferredPrompt = null;
        notifyListeners();
      }
      return choice.outcome;
    } catch {
      return 'unavailable';
    }
  }
  if (isIosSafari()) {
    return 'ios-manual';
  }
  return 'unavailable';
}

/** React Hook：获取当前 PWA 安装能力与独立窗口状态 */
export function usePwaInstall() {
  const [canInstall, setCanInstall] = useState<boolean>(() => Boolean(deferredPrompt) || isIosSafari());
  const [isStandalone, setIsStandalone] = useState<boolean>(() => isStandalonePwa());

  useEffect(() => {
    const update = () => {
      setCanInstall(Boolean(deferredPrompt) || isIosSafari());
      setIsStandalone(isStandalonePwa());
    };
    listeners.add(update);
    const mq = window.matchMedia('(display-mode: standalone)');
    mq.addEventListener?.('change', update);
    return () => {
      listeners.delete(update);
      mq.removeEventListener?.('change', update);
    };
  }, []);

  return {
    canInstall: !isTauri() && !isStandalone && canInstall,
    isStandalone,
    isIos: isIosSafari(),
    promptInstall: promptPwaInstall,
  };
}
