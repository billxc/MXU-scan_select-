import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Maximize2,
  X,
  Monitor,
  ChevronDown,
  Play,
  Pause,
  RefreshCw,
  Download,
  Copy,
  Unplug,
  MousePointerClick,
} from 'lucide-react';
import clsx from 'clsx';
import { maaService } from '@/services/maaService';
import { useAppStore } from '@/stores/appStore';
import { ContextMenu, useContextMenu, type MenuItem } from './ContextMenu';
import { getFrameInterval } from './FrameRateSelector';
import { isMuMuSavedDevice } from '@/utils/mumu';
import { loggers } from '@/utils/logger';
import { useIsMobile } from '@/hooks/useIsMobile';

const log = loggers.ui;

// 超时
const withTimeout = <T,>(promise: Promise<T>, ms: number): Promise<T> => {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
};

const MAX_CONSECUTIVE_FAILURES = 20;
const API_TIMEOUT = 30000;

export function ScreenshotPanel() {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const {
    activeInstanceId,
    instances,
    cachedAdbDevices,
    instanceConnectionStatus,
    instanceResourceLoaded,
    sidePanelExpanded,
    instanceScreenshotStreaming,
    setInstanceScreenshotStreaming,
    screenshotPanelExpanded,
    setScreenshotPanelExpanded,
    screenshotFrameRate,
  } = useAppStore();

  // 在移动端单列布局中，截图面板始终可见，不受 sidePanelExpanded 影响
  const isPanelVisible = isMobile || sidePanelExpanded;

  const instanceId = activeInstanceId || '';
  const activeInstance = instances.find((i) => i.id === instanceId);
  const isMuMu = isMuMuSavedDevice(activeInstance?.savedDevice, cachedAdbDevices);

  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [touchClickEnabled, setTouchClickEnabled] = useState(true);
  const [clickRipple, setClickRipple] = useState<{ id: number; xPct: number; yPct: number } | null>(
    null,
  );

  const { state: menuState, show: showMenu, hide: hideMenu } = useContextMenu();
  const fullscreenImgRef = useRef<HTMLImageElement>(null);
  const inlineImgRef = useRef<HTMLImageElement>(null);

  // 用于控制截图流的引用
  const streamingRef = useRef(false);
  const lastFrameTimeRef = useRef(0);
  const frameIntervalRef = useRef(getFrameInterval(screenshotFrameRate, isMuMu));

  // 帧率配置或 MuMu 状态变化时更新帧间隔
  useEffect(() => {
    frameIntervalRef.current = getFrameInterval(screenshotFrameRate, isMuMu);
  }, [screenshotFrameRate, isMuMu]);

  // 从 store 获取当前实例的截图流状态
  const isStreaming = instanceId ? (instanceScreenshotStreaming[instanceId] ?? false) : false;

  // 更新截图流状态
  const setIsStreaming = useCallback(
    (streaming: boolean) => {
      if (instanceId) {
        setInstanceScreenshotStreaming(instanceId, streaming);
      }
    },
    [instanceId, setInstanceScreenshotStreaming],
  );

  // 获取最新缓存截图（后端截图循环负责更新缓存，前端无需主动触发 postScreencap）
  const captureFrame = useCallback(async (): Promise<string | null> => {
    if (!instanceId) return null;

    try {
      const imageData = await withTimeout(maaService.getCachedImage(instanceId), API_TIMEOUT);
      return imageData || null;
    } catch (err) {
      log.warn('获取截图失败:', err);
      throw err;
    }
  }, [instanceId]);

  // 全屏模式切换
  const toggleFullscreen = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    setIsFullscreen(!isFullscreen);
  };

  // 组件卸载时停止截图流
  useEffect(() => {
    return () => {
      streamingRef.current = false;
    };
  }, []);

  // 订阅/退订后端截图循环（确保全局只有一份 post_screencap 在运行）
  useEffect(() => {
    if (!instanceId || !isStreaming) return;

    const intervalMs = getFrameInterval(screenshotFrameRate, isMuMu);
    maaService
      .screenshotSubscribe(instanceId, `panel-${instanceId}`, intervalMs)
      .catch((e) => log.warn('截图订阅失败:', e));

    return () => {
      maaService.screenshotUnsubscribe(instanceId, `panel-${instanceId}`).catch(() => {});
    };
  }, [instanceId, isStreaming, screenshotFrameRate, isMuMu]);

  // ESC 键退出全屏
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isFullscreen) {
        setIsFullscreen(false);
      }
    };

    if (isFullscreen) {
      document.addEventListener('keydown', handleKeyDown);
    }

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isFullscreen]);

  const loopRunningRef = useRef(false);

  const streamLoop = useCallback(async () => {
    if (loopRunningRef.current) return;
    loopRunningRef.current = true;

    const loopInstanceId = instanceId;
    let nextFrameTime = Date.now();
    let consecutiveFailures = 0;

    try {
      while (streamingRef.current) {
        // 检查当前实例是否仍是活动实例，避免非活动 tab 刷新截图
        const currentActiveId = useAppStore.getState().activeInstanceId;
        if (loopInstanceId !== currentActiveId) {
          break;
        }

        // 检查连接状态
        const connStatus = useAppStore.getState().instanceConnectionStatus[loopInstanceId];
        if (connStatus !== 'Connected') {
          setError('连接已断开');
          break;
        }

        // 等待下一帧时间
        const now = Date.now();
        const sleepTime = nextFrameTime - now;
        if (sleepTime > 0) {
          await new Promise((resolve) => setTimeout(resolve, sleepTime));
        }

        // 计算下一帧时间
        const frameInterval = frameIntervalRef.current;
        if (frameInterval > 0) {
          nextFrameTime += frameInterval;
          if (nextFrameTime < Date.now()) {
            nextFrameTime = Date.now() + frameInterval;
          }
        } else {
          nextFrameTime = Date.now();
        }

        lastFrameTimeRef.current = Date.now();

        try {
          // 后端截图循环已统一驱动 post_screencap，前端只需读取最新缓存
          const imageData = await captureFrame();

          // 再次检查是否仍是活动实例，避免更新非活动 tab 的截图
          if (
            imageData &&
            streamingRef.current &&
            loopInstanceId === useAppStore.getState().activeInstanceId
          ) {
            setScreenshotUrl(imageData);
            setError(null);
            consecutiveFailures = 0;
          }
        } catch (err) {
          consecutiveFailures++;
          log.warn(`截图失败 (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}):`, err);

          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            setError('截图连续失败，已停止');
            break;
          }
        }
      }

      // 循环结束
      streamingRef.current = false;
      setIsStreaming(false);
    } finally {
      loopRunningRef.current = false;
    }
  }, [instanceId, captureFrame, setIsStreaming]);

  // 开始/停止截图流
  const toggleStreaming = useCallback(
    (e?: React.MouseEvent) => {
      e?.stopPropagation();

      if (!instanceId) return;

      if (isStreaming) {
        // 停止流
        streamingRef.current = false;
        setIsStreaming(false);
      } else {
        // 开始流时，如果面板是折叠状态则自动展开
        if (!screenshotPanelExpanded) {
          setScreenshotPanelExpanded(true);
        }
        streamingRef.current = true;
        setIsStreaming(true);
        setError(null);
        streamLoop();
      }
    },
    [
      instanceId,
      isStreaming,
      setIsStreaming,
      streamLoop,
      screenshotPanelExpanded,
      setScreenshotPanelExpanded,
    ],
  );

  // 实例切换时重置截图和错误，但保留截图流状态
  useEffect(() => {
    // 清除截图，等待新实例的截图
    setScreenshotUrl(null);
    setError(null);

    // 同步 streamingRef 与新实例的截图流状态
    const newInstanceStreaming = instanceId
      ? (instanceScreenshotStreaming[instanceId] ?? false)
      : false;
    streamingRef.current = newInstanceStreaming;

    // 如果新实例的截图流是开启的，启动流循环
    if (newInstanceStreaming && instanceId) {
      streamLoop();
    }
  }, [instanceId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 连接成功后自动开始实时截图（仅当面板可见且未开启时）
  const connectionStatus = instanceId ? instanceConnectionStatus[instanceId] : undefined;
  const isResourceLoaded = instanceId ? instanceResourceLoaded[instanceId] : false;

  // 当设备已连接且资源已加载时：移动端或 MuMu 实例自动展开并开启实时流，非 MuMu 桌面端自动折叠
  useEffect(() => {
    if (connectionStatus === 'Connected' && isResourceLoaded) {
      if (isMuMu || isMobile) {
        setScreenshotPanelExpanded(true);
        if (instanceId && isPanelVisible) {
          streamingRef.current = true;
          setIsStreaming(true);
          setError(null);
          streamLoop();
        }
      } else {
        setScreenshotPanelExpanded(false);
      }
    }
  }, [
    connectionStatus,
    isResourceLoaded,
    isMuMu,
    isMobile,
    instanceId,
    isPanelVisible,
    setScreenshotPanelExpanded,
    setIsStreaming,
    streamLoop,
  ]);

  // 面板折叠时暂停截图，展开时自动开始（如果已连接）
  useEffect(() => {
    if (!screenshotPanelExpanded || !isPanelVisible) {
      // 折叠时暂停截图流，同步更新状态和图标
      streamingRef.current = false;
      setIsStreaming(false);
    } else if (connectionStatus === 'Connected' && instanceId) {
      // 展开且已连接时，自动开始截图
      streamingRef.current = true;
      setIsStreaming(true);
      setError(null);
      streamLoop();
    }
  }, [screenshotPanelExpanded, isPanelVisible]); // eslint-disable-line react-hooks/exhaustive-deps
  const prevConnectionStatusRef = useRef<typeof connectionStatus>(undefined);
  const hasAutoStartedRef = useRef(false);

  // 组件挂载或状态恢复后，如果已连接且面板可见，自动启动截图流
  useEffect(() => {
    // 避免重复启动（仅在首次检测到已连接时启动）
    if (hasAutoStartedRef.current) return;

    const isConnected = connectionStatus === 'Connected';
    if (isConnected && !isStreaming && screenshotPanelExpanded && isPanelVisible && instanceId) {
      hasAutoStartedRef.current = true;
      streamingRef.current = true;
      setIsStreaming(true);
      setError(null);
      streamLoop();
    }
  }, [
    connectionStatus,
    instanceId,
    screenshotPanelExpanded,
    isPanelVisible,
    isStreaming,
    setIsStreaming,
    streamLoop,
  ]);

  // 实例切换时重置自动启动标记
  useEffect(() => {
    hasAutoStartedRef.current = false;
  }, [instanceId]);

  // 保存截图
  const saveScreenshot = useCallback(async () => {
    if (!screenshotUrl) return;

    try {
      // 创建下载链接
      const link = document.createElement('a');
      link.href = screenshotUrl;
      link.download = `screenshot_${Date.now()}.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err) {
      log.warn('保存截图失败:', err);
    }
  }, [screenshotUrl]);

  // 复制截图到剪贴板
  const copyScreenshot = useCallback(async () => {
    if (!screenshotUrl) return;

    try {
      const response = await fetch(screenshotUrl);
      const blob = await response.blob();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    } catch (err) {
      log.warn('复制截图失败:', err);
    }
  }, [screenshotUrl]);

  // 强制刷新截图
  const forceRefresh = useCallback(async () => {
    if (!instanceId) return;

    try {
      const imageData = await captureFrame();
      if (imageData) {
        setScreenshotUrl(imageData);
        setError(null);
      }
    } catch (err) {
      log.warn('强制刷新失败:', err);
    }
  }, [instanceId, captureFrame]);

  // 断开连接（销毁实例）
  const disconnect = useCallback(async () => {
    if (!instanceId) return;

    try {
      await maaService.destroyInstance(instanceId);
      useAppStore.getState().setInstanceConnectionStatus(instanceId, 'Disconnected');
      useAppStore.getState().setInstanceResourceLoaded(instanceId, false);
      setScreenshotUrl(null);
      streamingRef.current = false;
      setIsStreaming(false);
    } catch (err) {
      log.warn('断开连接失败:', err);
    }
  }, [instanceId, setIsStreaming]);

  // 点击/触控/滑动画面图片 → 向设备实时发送 touch down / move / up 或 click
  const activePointersRef = useRef<
    Map<
      number,
      {
        contact: number;
        startX: number;
        startY: number;
        lastX: number;
        lastY: number;
        lastMoveMs: number;
      }
    >
  >(new Map());

  const resolveImageCoords = (
    clientX: number,
    clientY: number,
    img: HTMLImageElement | null,
  ): { x: number; y: number; xPct: number; yPct: number } | null => {
    if (!img) return null;
    const rect = img.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const naturalW = img.naturalWidth;
    const naturalH = img.naturalHeight;
    if (naturalW === 0 || naturalH === 0) return null;

    // 针对 object-contain 计算实际渲染的内容区（扣除黑边）
    const imgRatio = naturalW / naturalH;
    const boxRatio = rect.width / rect.height;
    let renderW = rect.width;
    let renderH = rect.height;
    let offsetX = 0;
    let offsetY = 0;
    if (boxRatio > imgRatio) {
      renderW = rect.height * imgRatio;
      offsetX = (rect.width - renderW) / 2;
    } else {
      renderH = rect.width / imgRatio;
      offsetY = (rect.height - renderH) / 2;
    }

    const relX = clientX - rect.left - offsetX;
    const relY = clientY - rect.top - offsetY;
    const clampedX = Math.max(0, Math.min(renderW, relX));
    const clampedY = Math.max(0, Math.min(renderH, relY));

    const x = Math.round((clampedX / renderW) * (naturalW - 1));
    const y = Math.round((clampedY / renderH) * (naturalH - 1));
    const xPct = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
    const yPct = Math.max(0, Math.min(100, ((clientY - rect.top) / rect.height) * 100));
    return { x, y, xPct, yPct };
  };

  const acquireTouchSlot = (): number => {
    const used = new Set(Array.from(activePointersRef.current.values()).map((v) => v.contact));
    for (let i = 0; i < 10; i++) {
      if (!used.has(i)) return i;
    }
    return 0;
  };

  const handlePointerDown = useCallback(
    (
      e: React.PointerEvent<HTMLImageElement>,
      imgRef: React.RefObject<HTMLImageElement | null>,
      isInline: boolean,
    ) => {
      if (isInline && !touchClickEnabled) return;
      if (!instanceId || connectionStatus !== 'Connected') return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;

      const coords = resolveImageCoords(e.clientX, e.clientY, imgRef.current);
      if (!coords) return;

      e.preventDefault();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }

      const contact = acquireTouchSlot();
      activePointersRef.current.set(e.pointerId, {
        contact,
        startX: coords.x,
        startY: coords.y,
        lastX: coords.x,
        lastY: coords.y,
        lastMoveMs: performance.now(),
      });

      if (isInline) {
        const rippleId = Date.now();
        setClickRipple({ id: rippleId, xPct: coords.xPct, yPct: coords.yPct });
        setTimeout(() => {
          setClickRipple((prev) => (prev?.id === rippleId ? null : prev));
        }, 450);
      }

      maaService.postTouch(instanceId, 'down', coords.x, coords.y, contact).catch((err) => {
        log.warn('触控按下失败:', err);
      });
    },
    [instanceId, connectionStatus, touchClickEnabled],
  );

  const handlePointerMove = useCallback(
    (
      e: React.PointerEvent<HTMLImageElement>,
      imgRef: React.RefObject<HTMLImageElement | null>,
    ) => {
      const slot = activePointersRef.current.get(e.pointerId);
      if (!slot || !instanceId || connectionStatus !== 'Connected') return;

      const coords = resolveImageCoords(e.clientX, e.clientY, imgRef.current);
      if (!coords) return;

      const now = performance.now();
      const dx = Math.abs(coords.x - slot.lastX);
      const dy = Math.abs(coords.y - slot.lastY);
      if (dx < 2 && dy < 2) return;
      if (now - slot.lastMoveMs < 16 && dx < 12 && dy < 12) return;

      slot.lastX = coords.x;
      slot.lastY = coords.y;
      slot.lastMoveMs = now;

      maaService.postTouch(instanceId, 'move', coords.x, coords.y, slot.contact).catch(() => {});
    },
    [instanceId, connectionStatus],
  );

  const handlePointerUpOrCancel = useCallback(
    (
      e: React.PointerEvent<HTMLImageElement>,
      imgRef: React.RefObject<HTMLImageElement | null>,
    ) => {
      const slot = activePointersRef.current.get(e.pointerId);
      if (!slot) return;
      activePointersRef.current.delete(e.pointerId);

      try {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
      } catch {
        // ignore
      }

      if (!instanceId || connectionStatus !== 'Connected') return;
      const coords = resolveImageCoords(e.clientX, e.clientY, imgRef.current) ?? {
        x: slot.lastX,
        y: slot.lastY,
      };

      maaService.postTouch(instanceId, 'up', coords.x, coords.y, slot.contact).catch((err) => {
        log.warn('触控抬起失败:', err);
      });
    },
    [instanceId, connectionStatus],
  );

  // 右键菜单处理
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const isConnected = connectionStatus === 'Connected';

      const menuItems: MenuItem[] = [
        {
          id: 'stream',
          label: isStreaming ? t('contextMenu.stopStream') : t('contextMenu.startStream'),
          icon: isStreaming ? Pause : Play,
          disabled: !instanceId || !isConnected,
          onClick: () => toggleStreaming(),
        },
        {
          id: 'refresh',
          label: t('contextMenu.forceRefresh'),
          icon: RefreshCw,
          disabled: !instanceId || !isConnected,
          onClick: forceRefresh,
        },
        { id: 'divider-1', label: '', divider: true },
        {
          id: 'fullscreen',
          label: t('contextMenu.fullscreen'),
          icon: Maximize2,
          disabled: !screenshotUrl,
          onClick: () => setIsFullscreen(true),
        },
        { id: 'divider-2', label: '', divider: true },
        {
          id: 'save',
          label: t('contextMenu.saveScreenshot'),
          icon: Download,
          disabled: !screenshotUrl,
          onClick: saveScreenshot,
        },
        {
          id: 'copy',
          label: t('contextMenu.copyScreenshot'),
          icon: Copy,
          disabled: !screenshotUrl,
          onClick: copyScreenshot,
        },
        { id: 'divider-3', label: '', divider: true },
        {
          id: 'disconnect',
          label: t('contextMenu.disconnect'),
          icon: Unplug,
          disabled: !isConnected,
          danger: true,
          onClick: disconnect,
        },
      ];

      showMenu(e, menuItems);
    },
    [
      t,
      instanceId,
      connectionStatus,
      isStreaming,
      screenshotUrl,
      toggleStreaming,
      forceRefresh,
      saveScreenshot,
      copyScreenshot,
      disconnect,
      showMenu,
    ],
  );

  useEffect(() => {
    // 检测连接状态从非 Connected 变为 Connected
    const wasConnected = prevConnectionStatusRef.current === 'Connected';
    const isConnected = connectionStatus === 'Connected';
    prevConnectionStatusRef.current = connectionStatus;

    // 连接断开时清空截图（如切换控制器、断开连接等场景）
    if (wasConnected && !isConnected) {
      setScreenshotUrl(null);
      streamingRef.current = false;
      setIsStreaming(false);
    }

    if (
      isConnected &&
      !wasConnected &&
      !isStreaming &&
      screenshotPanelExpanded &&
      isPanelVisible &&
      instanceId
    ) {
      streamingRef.current = true;
      setIsStreaming(true);
      setError(null);
      streamLoop();
    }
  }, [
    connectionStatus,
    instanceId,
    screenshotPanelExpanded,
    isPanelVisible,
    isStreaming,
    setIsStreaming,
    streamLoop,
  ]);

  return (
    <div className="bg-bg-secondary rounded-lg ring-1 ring-inset ring-border overflow-hidden">
      {/* 标题栏（可点击折叠） */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => setScreenshotPanelExpanded(!screenshotPanelExpanded)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            (e.currentTarget as HTMLElement).click();
          }
        }}
        className={clsx(
          'w-full flex items-center justify-between px-3 py-2 hover:bg-bg-hover cursor-pointer focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50 outline-none',
          screenshotPanelExpanded ? 'rounded-t-lg' : 'rounded-lg',
        )}
        style={{
          transition: `background-color 150ms, border-radius 0s${screenshotPanelExpanded ? '' : ' 150ms'}`,
        }}
      >
        <div className="flex items-center gap-2">
          <Monitor className="w-4 h-4 text-text-secondary" />
          <span className="text-sm font-medium text-text-primary">{t('screenshot.title')}</span>
        </div>
        <div className="flex items-center gap-2">
          {/* 触控点击开关按钮 */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              setTouchClickEnabled(!touchClickEnabled);
            }}
            disabled={!instanceId || connectionStatus !== 'Connected'}
            className={clsx(
              'p-1 rounded-md transition-colors',
              !instanceId || connectionStatus !== 'Connected'
                ? 'text-text-muted cursor-not-allowed'
                : touchClickEnabled
                  ? 'text-accent bg-accent/10 hover:bg-bg-tertiary'
                  : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary',
            )}
            title={t('screenshot.clickHint')}
          >
            <MousePointerClick className="w-3.5 h-3.5" />
          </button>

          {/* 流模式开关按钮 */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              toggleStreaming();
            }}
            disabled={!instanceId}
            className={clsx(
              'p-1 rounded-md transition-colors',
              !instanceId
                ? 'text-text-muted cursor-not-allowed'
                : isStreaming
                  ? 'text-success hover:bg-bg-tertiary'
                  : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary',
            )}
            title={isStreaming ? t('screenshot.stopStream') : t('screenshot.startStream')}
          >
            {isStreaming ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
          </button>

          {/* 全屏按钮 */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              toggleFullscreen();
            }}
            disabled={!screenshotUrl}
            className={clsx(
              'p-1 rounded-md transition-colors',
              !screenshotUrl
                ? 'text-text-muted cursor-not-allowed'
                : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary',
            )}
            title={t('screenshot.fullscreen')}
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
          <ChevronDown
            className={clsx(
              'w-4 h-4 text-text-muted transition-transform duration-150 ease-out',
              screenshotPanelExpanded && 'rotate-180',
            )}
          />
        </div>
      </div>

      {/* 可折叠内容 - 使用 grid 动画实现平滑展开/折叠 */}
      <div
        className="grid transition-[grid-template-rows] duration-150 ease-out"
        style={{ gridTemplateRows: screenshotPanelExpanded ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden min-h-0">
          {/* 分隔线放在 overflow-hidden 内部，避免展开瞬间闪烁 */}
          <div className="border-t border-border" />
          <div className="p-3">
            {/* 截图区域 */}
            <div
              className="aspect-video bg-bg-tertiary rounded-md flex items-center justify-center overflow-hidden relative"
              onContextMenu={handleContextMenu}
            >
              {screenshotUrl ? (
                <>
                  <img
                    ref={inlineImgRef}
                    src={screenshotUrl}
                    alt="Screenshot"
                    draggable={false}
                    onPointerDown={(e) => handlePointerDown(e, inlineImgRef, true)}
                    onPointerMove={(e) => handlePointerMove(e, inlineImgRef)}
                    onPointerUp={(e) => handlePointerUpOrCancel(e, inlineImgRef)}
                    onPointerCancel={(e) => handlePointerUpOrCancel(e, inlineImgRef)}
                    className={clsx(
                      'w-full h-full object-contain rounded-md select-none',
                      touchClickEnabled &&
                        connectionStatus === 'Connected' &&
                        'cursor-crosshair touch-none',
                    )}
                  />
                  {clickRipple && (
                    <span
                      key={clickRipple.id}
                      style={{ left: `${clickRipple.xPct}%`, top: `${clickRipple.yPct}%` }}
                      className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 w-6 h-6 rounded-full border-2 border-accent bg-accent/30 animate-ping"
                    />
                  )}
                  {/* 流模式指示器 */}
                  {isStreaming && (
                    <div className="absolute top-2 right-2 flex items-center gap-1 px-1.5 py-0.5 bg-success/80 rounded text-white text-xs pointer-events-none">
                      <span className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" />
                      LIVE
                    </div>
                  )}
                </>
              ) : (
                <div className="flex flex-col items-center gap-2 text-text-muted">
                  <Monitor className="w-10 h-10 opacity-30" />
                  {error ? (
                    <span className="text-xs text-error">{error}</span>
                  ) : (
                    <>
                      <span className="text-xs">{t('screenshot.noScreenshot')}</span>
                      <span className="text-xs text-text-muted">
                        {t('screenshot.connectFirst')}
                      </span>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 全屏模态框 */}
      {isFullscreen && screenshotUrl && (
        <div
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-2 sm:p-8"
          onClick={toggleFullscreen}
        >
          {/* 卡片容器 */}
          <div
            className="mxu-overlay-surface relative bg-bg-secondary rounded-xl border border-border shadow-2xl max-w-[98vw] sm:max-w-[90vw] max-h-[95vh] sm:max-h-[90vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
            onContextMenu={handleContextMenu}
          >
            {/* 卡片标题栏 */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-bg-tertiary/50">
              <div className="flex items-center gap-2">
                <Monitor className="w-4 h-4 text-text-secondary" />
                <span className="text-sm font-medium text-text-primary">
                  {t('screenshot.title')}
                </span>
                {/* 流模式指示器 */}
                {isStreaming && (
                  <div className="flex items-center gap-1 px-2 py-0.5 bg-success/90 rounded text-white text-xs ml-2">
                    <span className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" />
                    LIVE
                  </div>
                )}
              </div>
              <button
                onClick={toggleFullscreen}
                className="p-1.5 rounded-md hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors"
                title={t('screenshot.exitFullscreen')}
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* 图片内容区 */}
            <div className="p-4 pb-2 bg-bg-primary flex flex-col items-center justify-center overflow-auto">
              <img
                ref={fullscreenImgRef}
                src={screenshotUrl}
                alt="Screenshot"
                draggable={false}
                onPointerDown={(e) => handlePointerDown(e, fullscreenImgRef, false)}
                onPointerMove={(e) => handlePointerMove(e, fullscreenImgRef)}
                onPointerUp={(e) => handlePointerUpOrCancel(e, fullscreenImgRef)}
                onPointerCancel={(e) => handlePointerUpOrCancel(e, fullscreenImgRef)}
                className="max-w-full max-h-[calc(90vh-100px)] object-contain rounded-md cursor-crosshair select-none touch-none"
              />
              {connectionStatus === 'Connected' && (
                <div className="flex items-center gap-1 mt-2 text-xs text-text-muted select-none">
                  <MousePointerClick className="w-3 h-3" />
                  <span>{t('screenshot.clickHint')}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 右键菜单 */}
      {menuState.isOpen && (
        <ContextMenu items={menuState.items} position={menuState.position} onClose={hideMenu} />
      )}
    </div>
  );
}
