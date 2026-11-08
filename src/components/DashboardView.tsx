import { useState, useEffect, useRef, useCallback, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import {
  LayoutGrid,
  Monitor,
  Play,
  Pause,
  RefreshCw,
  Download,
  Unplug,
  Maximize2,
  Copy,
  X,
  Wifi,
  WifiOff,
  CheckCircle,
  Loader2,
  StopCircle,
  AlignLeft,
  AlignCenter,
  AlignRight,
  ZoomIn,
  ZoomOut,
  MoreVertical,
  Plus,
  Edit3,
  Trash2,
  Check,
} from 'lucide-react';
import clsx from 'clsx';
import { useAppStore } from '@/stores/appStore';
import { maaService } from '@/services/maaService';
import { ContextMenu, useContextMenu, type MenuItem } from './ContextMenu';
import { ConfirmDialog } from './ConfirmDialog';
import { FrameRateSelector, getFrameInterval } from './FrameRateSelector';
import { isMuMuSavedDevice } from '@/utils/mumu';
import { resolveI18nText } from '@/services/contentResolver';
import { loggers } from '@/utils';
import { getLinuxDeviceName } from '@/utils/controller';
import { getInterfaceLangKey } from '@/i18n';
import { stopInstanceTasks } from '@/services/taskStopService';
import { taskStartService } from '@/services/taskStartService';
import { isTaskSelectedForRun } from '@/utils/taskRunFilter';
import { useIsMobile } from '@/hooks/useIsMobile';

const log = loggers.ui;

interface InstanceCardProps {
  instanceId: string;
  instanceName: string;
  isActive: boolean;
  onSelect: () => void;
}

function InstanceCard({ instanceId, instanceName, isActive, onSelect }: InstanceCardProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const {
    instances,
    cachedAdbDevices,
    instanceConnectionStatus,
    instanceTaskStatus,
    instanceScreenshotStreaming,
    setInstanceScreenshotStreaming,
    setInstanceConnectionStatus,
    projectInterface,
    selectedController,
    selectedResource,
    interfaceTranslations,
    language,
    instanceTaskRunStatus,
    resolveI18nText: storeResolveI18nText,
    screenshotFrameRate,
    duplicateInstance,
    renameInstance,
    startTabCloseAnimation,
    confirmBeforeDelete,
  } = useAppStore();

  const langKey = getInterfaceLangKey(language);
  const translations = interfaceTranslations[langKey];

  const { state: menuState, show: showMenu, showAt: showMenuAt, hide: hideMenu } = useContextMenu();

  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  const streamingRef = useRef(false);
  const lastFrameTimeRef = useRef(0);

  // 获取当前实例
  const instance = instances.find((i) => i.id === instanceId);
  const isMuMu = isMuMuSavedDevice(instance?.savedDevice, cachedAdbDevices);
  const frameIntervalRef = useRef(getFrameInterval(screenshotFrameRate, isMuMu));

  // 帧率配置或 MuMu 状态变化时更新帧间隔
  useEffect(() => {
    frameIntervalRef.current = getFrameInterval(screenshotFrameRate, isMuMu);
  }, [screenshotFrameRate, isMuMu]);

  const connectionStatus = instanceConnectionStatus[instanceId];
  const taskStatus = instanceTaskStatus[instanceId];
  const isStreaming = instanceScreenshotStreaming[instanceId] ?? false;
  const isConnected = connectionStatus === 'Connected';

  const isRunning = instance?.isRunning || false;
  const tasks = instance?.selectedTasks || [];
  const canRun = tasks.some(isTaskSelectedForRun);

    // 获取连接状态信息
  const getStatusInfo = useCallback(() => {
    const controllers = projectInterface?.controller || [];
    const resources = projectInterface?.resource || [];
    const currentControllerName =
      selectedController[instanceId] || instance?.controllerName || controllers[0]?.name;
    const currentResourceName =
      selectedResource[instanceId] || instance?.resourceName || resources[0]?.name;
    const currentController = controllers.find((c) => c.name === currentControllerName);
    const currentResource = resources.find((r) => r.name === currentResourceName);

    // 获取设备名称
    const savedDevice = instance?.savedDevice;
    let deviceName = '';
    if (savedDevice?.adbDeviceName) {
      deviceName = savedDevice.adbDeviceName;
    } else if (savedDevice?.windowName) {
      deviceName = savedDevice.windowName;
    } else if (currentController?.type === 'Linux' && savedDevice) {
      // Linux：按当前配置输出实际使用的设备（portal/uinput 等忽略残留的 gamescope-<n>）
      deviceName = getLinuxDeviceName(
        currentController,
        {
          wlrSocketPath: savedDevice.wlrSocketPath,
          gamescopeDisplayNo: savedDevice.gamescopeDisplayNo,
        },
        { portal: t('controller.portal'), linux: t('controller.linux') },
      );
    } else if (savedDevice?.wlrSocketPath) {
      deviceName = savedDevice.wlrSocketPath;
    } else if (savedDevice?.playcoverAddress) {
      deviceName = savedDevice.playcoverAddress;
    }

    const controllerLabel = currentController
      ? resolveI18nText(currentController.label, translations) || currentController.name
      : '';
    const resourceLabel = currentResource
      ? resolveI18nText(currentResource.label, translations) || currentResource.name
      : '';

    return { controllerLabel, resourceLabel, deviceName };
  }, [projectInterface, selectedController, selectedResource, instance, instanceId, translations]);

  const statusInfo = getStatusInfo();

  // 获取当前正在运行的任务名称
  const getRunningTaskName = useCallback(() => {
    if (!instance?.isRunning) return null;

    const taskRunStatus = instanceTaskRunStatus[instanceId];
    if (!taskRunStatus) return null;

    // 找到状态为 running 的任务
    const runningTaskId = Object.entries(taskRunStatus).find(
      ([, status]) => status === 'running',
    )?.[0];

    if (!runningTaskId) return null;

    // 找到对应的 selectedTask
    const selectedTask = instance.selectedTasks.find((t) => t.id === runningTaskId);
    if (!selectedTask) return null;

    // 如果有自定义名称，使用自定义名称
    if (selectedTask.customName) return selectedTask.customName;

    // 否则从 projectInterface 获取任务的显示名称
    const taskDef = projectInterface?.task.find((t) => t.name === selectedTask.taskName);
    if (taskDef) {
      return storeResolveI18nText(taskDef.label, langKey) || taskDef.name;
    }

    return selectedTask.taskName;
  }, [
    instance,
    instanceId,
    instanceTaskRunStatus,
    projectInterface,
    storeResolveI18nText,
    langKey,
  ]);

  const runningTaskName = getRunningTaskName();

  // 启动/停止任务（复用 Toolbar 的 taskStartService 与 stopInstanceTasks）
  const handleStartStop = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();

      if (!instance || (!canRun && !isRunning)) return;

      if (isRunning) {
        try {
          log.info(`[${instanceName}] 停止任务...`);
          setIsStopping(true);
          const stopped = await stopInstanceTasks(instanceId);
          if (!stopped) {
            log.warn(`[${instanceName}] 等待任务停止超时，保留当前运行状态`);
          }
        } catch (err) {
          log.error(`[${instanceName}] 停止任务失败:`, err);
        } finally {
          setIsStopping(false);
        }
      } else {
        if (!canRun) return;
        setIsStarting(true);
        try {
          await taskStartService.start(instance);
        } catch (err) {
          log.error(`[${instanceName}] 任务启动异常:`, err);
        } finally {
          setIsStarting(false);
        }
      }
    },
    [instance, instanceId, instanceName, isRunning, canRun],
  );

  // 获取最新缓存截图（后端截图循环负责更新缓存，前端无需主动触发 postScreencap）
  const captureFrame = useCallback(async (): Promise<string | null> => {
    if (!instanceId) return null;

    try {
      const imageData = await maaService.getCachedImage(instanceId);
      return imageData || null;
    } catch {
      return null;
    }
  }, [instanceId]);

  const loopRunningRef = useRef(false);

  const streamLoop = useCallback(async () => {
    if (loopRunningRef.current) return;
    loopRunningRef.current = true;

    try {
      let nextFrameTime = Date.now();

      while (streamingRef.current) {
        const now = Date.now();
        const sleepTime = nextFrameTime - now;
        if (sleepTime > 0) {
          await new Promise((resolve) => setTimeout(resolve, sleepTime));
        }

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
          const imageData = await captureFrame();
          if (imageData && streamingRef.current) {
            setScreenshotUrl(imageData);
          }
        } catch {
          // 静默处理
        }
      }
    } finally {
      loopRunningRef.current = false;
    }
  }, [instanceId, captureFrame]);

  // 组件卸载时停止流
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
      .screenshotSubscribe(instanceId, `dashboard-${instanceId}`, intervalMs)
      .catch(() => {});

    return () => {
      maaService.screenshotUnsubscribe(instanceId, `dashboard-${instanceId}`).catch(() => {});
    };
  }, [instanceId, isStreaming, screenshotFrameRate, isMuMu]);

  // 响应 store 中 isStreaming 状态变化
  useEffect(() => {
    // 同步 ref 与 store 状态
    streamingRef.current = isStreaming;

    // 如果状态变为开启且已连接，启动流
    if (isStreaming && isConnected) {
      streamLoop();
    }
  }, [isStreaming, isConnected, streamLoop]);

  // 连接后自动开始截图流
  const prevConnectedRef = useRef(false);
  const hasAutoStartedRef = useRef(false);

  // 组件挂载或状态恢复后，如果已连接，自动启动截图流
  useEffect(() => {
    // 避免重复启动
    if (hasAutoStartedRef.current) return;

    if (isConnected && !isStreaming) {
      hasAutoStartedRef.current = true;
      streamingRef.current = true;
      setInstanceScreenshotStreaming(instanceId, true);
      streamLoop();
    }
  }, [isConnected, isStreaming, instanceId, setInstanceScreenshotStreaming, streamLoop]);

  // 连接状态变化时的处理（从未连接变为已连接时重新启动）
  useEffect(() => {
    const wasConnected = prevConnectedRef.current;
    prevConnectedRef.current = isConnected;

    // 从未连接变为已连接时，重置自动启动标记并启动
    if (isConnected && !wasConnected && !isStreaming) {
      hasAutoStartedRef.current = true;
      streamingRef.current = true;
      setInstanceScreenshotStreaming(instanceId, true);
      streamLoop();
    }
  }, [isConnected, isStreaming, instanceId, setInstanceScreenshotStreaming, streamLoop]);

  // 全屏模式切换
  const toggleFullscreen = useCallback(
    (e?: React.MouseEvent) => {
      e?.stopPropagation();
      setIsFullscreen(!isFullscreen);
    },
    [isFullscreen],
  );

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

  // 保存截图
  const saveScreenshot = useCallback(async () => {
    if (!screenshotUrl) return;
    try {
      const link = document.createElement('a');
      link.href = screenshotUrl;
      link.download = `screenshot_${instanceName}_${Date.now()}.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch {
      // 静默处理
    }
  }, [screenshotUrl, instanceName]);

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

  // 断开连接
  const disconnect = useCallback(async () => {
    try {
      await maaService.destroyInstance(instanceId);
      setInstanceConnectionStatus(instanceId, 'Disconnected');
      useAppStore.getState().setInstanceResourceLoaded(instanceId, false);
      setScreenshotUrl(null);
      streamingRef.current = false;
      setInstanceScreenshotStreaming(instanceId, false);
    } catch {
      // 静默处理
    }
  }, [instanceId, setInstanceConnectionStatus, setInstanceScreenshotStreaming]);

  // 强制刷新
  const forceRefresh = useCallback(async () => {
    const imageData = await captureFrame();
    if (imageData) {
      setScreenshotUrl(imageData);
    }
  }, [captureFrame]);

  const handleSaveEdit = useCallback(() => {
    if (editName.trim()) {
      renameInstance(instanceId, editName.trim());
    }
    setIsEditing(false);
    setEditName('');
  }, [editName, instanceId, renameInstance]);

  const handleCancelEdit = useCallback(() => {
    setIsEditing(false);
    setEditName('');
  }, []);

  const requestCloseInstance = useCallback(() => {
    if (instances.length <= 1) return;
    if (confirmBeforeDelete) {
      setShowCloseConfirm(true);
    } else {
      startTabCloseAnimation(instanceId);
    }
  }, [instances.length, confirmBeforeDelete, instanceId, startTabCloseAnimation]);

  const buildMenuItems = useCallback((): MenuItem[] => {
    return [
      {
        id: 'run-stop',
        label: isRunning ? t('taskList.stopTasks') : t('taskList.startTasks'),
        icon: isRunning ? StopCircle : Play,
        disabled: isStarting || isStopping || (!canRun && !isRunning),
        onClick: () => {
          if (!instance) return;
          if (isRunning) {
            void stopInstanceTasks(instanceId);
          } else if (canRun) {
            void taskStartService.start(instance);
          }
        },
      },
      {
        id: 'duplicate-instance',
        label: t('contextMenu.duplicateTab'),
        icon: Copy,
        onClick: () => duplicateInstance(instanceId),
      },
      {
        id: 'rename-instance',
        label: t('contextMenu.renameTab'),
        icon: Edit3,
        onClick: () => {
          setEditName(instanceName);
          setIsEditing(true);
        },
      },
      {
        id: 'close-instance',
        label: t('contextMenu.closeTab'),
        icon: Trash2,
        disabled: instances.length <= 1,
        danger: true,
        onClick: requestCloseInstance,
      },
      { id: 'divider-instance', label: '', divider: true },
      {
        id: 'stream',
        label: isStreaming ? t('contextMenu.stopStream') : t('contextMenu.startStream'),
        icon: isStreaming ? Pause : Play,
        disabled: !isConnected,
        onClick: () => {
          if (!instanceId || !isConnected) return;
          if (isStreaming) {
            streamingRef.current = false;
            setInstanceScreenshotStreaming(instanceId, false);
          } else {
            streamingRef.current = true;
            setInstanceScreenshotStreaming(instanceId, true);
            streamLoop();
          }
        },
      },
      {
        id: 'refresh',
        label: t('contextMenu.forceRefresh'),
        icon: RefreshCw,
        disabled: !isConnected,
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
  }, [
    t,
    instance,
    instanceId,
    instanceName,
    instances.length,
    isRunning,
    isStarting,
    isStopping,
    canRun,
    isConnected,
    isStreaming,
    screenshotUrl,
    duplicateInstance,
    requestCloseInstance,
    setInstanceScreenshotStreaming,
    streamLoop,
    forceRefresh,
    saveScreenshot,
    copyScreenshot,
    disconnect,
  ]);

  // 右键菜单（复用首页截图面板的菜单结构 + 实例管理项）
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable ||
        target?.closest('input, textarea, [contenteditable="true"]')
      ) {
        e.stopPropagation();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      showMenu(e, buildMenuItems());
    },
    [buildMenuItems, showMenu],
  );

  const handleOpenMenuAtButton = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      const rect = e.currentTarget.getBoundingClientRect();
      showMenuAt({ x: rect.left, y: rect.bottom + 4 }, buildMenuItems());
    },
    [buildMenuItems, showMenuAt],
  );

  return (
    <div
      onClick={() => {
        if (!isEditing) onSelect();
      }}
      onContextMenu={isMobile ? undefined : handleContextMenu}
      className={clsx(
        'group relative bg-bg-secondary rounded-xl border-2 overflow-hidden cursor-pointer transition-all duration-200 hover:scale-[1.02] hover:shadow-lg',
        isActive ? 'border-accent shadow-md' : 'border-border hover:border-accent/50',
      )}
    >
      {/* 截图区域 */}
      <div className="aspect-video bg-bg-tertiary relative overflow-hidden">
        {screenshotUrl ? (
          <>
            <img src={screenshotUrl} alt="Screenshot" className="w-full h-full object-contain" />
            {/* 流状态指示器 */}
            {isStreaming && (
              <div className="absolute top-2 right-2 flex items-center gap-1 px-1.5 py-0.5 bg-success/80 rounded text-white text-xs">
                <span className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" />
                LIVE
              </div>
            )}
          </>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-text-muted">
            <Monitor className="w-8 h-8 opacity-30 mb-1" />
            <span className="text-xs">
              {isConnected ? t('screenshot.noScreenshot') : t('screenshot.connectFirst')}
            </span>
          </div>
        )}

        {/* 任务控制按钮（支持未连接时通过 taskStartService 自动启动 MuMu / 自动连接并执行） */}
        {(canRun || isRunning || isConnected) && (
          <button
            type="button"
            onClick={handleStartStop}
            disabled={isStarting || isStopping || (!canRun && !isRunning)}
            className={clsx(
              'absolute bottom-2 right-2 p-2 sm:p-1.5 rounded-md transition-all shadow-sm',
              isStarting || isStopping
                ? 'bg-yellow-500/80 text-white'
                : isRunning
                  ? 'bg-red-500/80 hover:bg-red-600/80 text-white'
                  : canRun
                    ? 'bg-success/85 hover:bg-success text-white'
                    : 'bg-black/30 text-white/50 cursor-not-allowed',
              'opacity-100 sm:opacity-0 sm:group-hover:opacity-100',
            )}
            title={
              isStarting
                ? t('taskList.startingTasks')
                : isStopping
                  ? t('taskList.stoppingTasks')
                  : isRunning
                    ? t('taskList.stopTasks')
                    : canRun
                      ? t('taskList.startTasks')
                      : t('dashboard.noEnabledTasks')
            }
          >
            {isStarting || isStopping ? (
              <Loader2 className="w-3.5 h-3.5 sm:w-3 sm:h-3 animate-spin" />
            ) : isRunning ? (
              <StopCircle className="w-3.5 h-3.5 sm:w-3 sm:h-3" />
            ) : (
              <Play className="w-3.5 h-3.5 sm:w-3 sm:h-3" />
            )}
          </button>
        )}
      </div>

      {/* 实例信息栏 */}
      <div className="px-3 py-2 border-t border-border">
        <div className="flex items-center justify-between gap-2">
          {/* 左侧：实例名称 + 控制器/设备信息 */}
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {isEditing ? (
              <div
                className="flex items-center gap-1 flex-1 min-w-0"
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSaveEdit();
                    else if (e.key === 'Escape') handleCancelEdit();
                  }}
                  onBlur={handleSaveEdit}
                  autoFocus
                  className="flex-1 min-w-0 px-2 py-0.5 text-sm rounded border border-accent bg-bg-primary text-text-primary focus:outline-none"
                />
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleSaveEdit();
                  }}
                  className="p-1 rounded hover:bg-success/10 text-success"
                >
                  <Check className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleCancelEdit();
                  }}
                  className="p-1 rounded hover:bg-error/10 text-error"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <>
                <span
                  className={clsx(
                    'font-medium truncate flex-shrink-0',
                    isActive ? 'text-accent' : 'text-text-primary',
                  )}
                >
                  {instanceName}
                </span>
                {/* 控制器/设备信息标签 */}
                {(statusInfo.controllerLabel || statusInfo.deviceName) && (
                  <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-bg-tertiary text-text-secondary text-xs truncate min-w-0">
                    {isConnected ? (
                      <Wifi className="w-3 h-3 text-success flex-shrink-0" />
                    ) : (
                      <WifiOff className="w-3 h-3 text-text-muted flex-shrink-0" />
                    )}
                    <span className="truncate">
                      {statusInfo.deviceName || statusInfo.controllerLabel}
                    </span>
                  </div>
                )}
                {/* 资源信息标签 - 单独显示以增加间距 */}
                {statusInfo.resourceLabel && (
                  <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-bg-tertiary text-text-secondary text-xs truncate min-w-0">
                    <CheckCircle className="w-3 h-3 text-success flex-shrink-0" />
                    <span className="truncate">{statusInfo.resourceLabel}</span>
                  </div>
                )}
              </>
            )}
          </div>

          {/* 右侧：状态按钮（可点击直接启动/停止任务） + 移动端更多菜单按钮 */}
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              type="button"
              onClick={(e) => {
                if (canRun || isRunning) {
                  void handleStartStop(e);
                }
              }}
              className={clsx(
                'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors flex-shrink-0',
                isRunning || taskStatus === 'Running'
                  ? 'bg-success text-white'
                  : taskStatus === 'Failed'
                    ? 'bg-error text-white'
                    : taskStatus === 'Succeeded'
                      ? 'bg-accent text-white'
                      : isConnected
                        ? 'bg-bg-tertiary text-text-secondary'
                        : 'bg-bg-active text-text-tertiary',
              )}
              title={
                isRunning
                  ? t('taskList.stopTasks')
                  : canRun
                    ? t('taskList.startTasks')
                    : undefined
              }
            >
              {isRunning || taskStatus === 'Running' ? (
                <>
                  <Loader2 className="w-3 h-3 animate-spin" />
                  <span className="truncate max-w-[80px]">
                    {runningTaskName || t('dashboard.running')}
                  </span>
                </>
              ) : taskStatus === 'Failed' ? (
                <>
                  <StopCircle className="w-3 h-3" />
                  <span>{t('dashboard.failed')}</span>
                </>
              ) : taskStatus === 'Succeeded' ? (
                <>
                  <CheckCircle className="w-3 h-3" />
                  <span>{t('dashboard.succeeded')}</span>
                </>
              ) : isConnected ? (
                <>
                  <Play className="w-3 h-3" />
                  <span>{t('controller.connected')}</span>
                </>
              ) : (
                <>
                  <WifiOff className="w-3 h-3" />
                  <span>{t('controller.disconnected')}</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={handleOpenMenuAtButton}
              className="sm:hidden p-1.5 rounded-md text-text-muted hover:bg-bg-hover hover:text-text-primary transition-colors"
              title={t('common.edit')}
            >
              <MoreVertical className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* 运行中动画边框 */}
      {taskStatus === 'Running' && (
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute inset-0 rounded-xl border-2 border-green-500/50 animate-pulse" />
        </div>
      )}

      {/* 右键菜单 */}
      {menuState.isOpen && (
        <ContextMenu items={menuState.items} position={menuState.position} onClose={hideMenu} />
      )}

      {/* 确认删除弹窗（包裹阻止冒泡，防止点击确认/取消误触卡片选中） */}
      {showCloseConfirm && (
        <div onClick={(e) => e.stopPropagation()}>
          <ConfirmDialog
            open={showCloseConfirm}
            title={t('titleBar.closeTabConfirmTitle')}
            message={t('titleBar.closeTabConfirmMessage', { name: instanceName })}
            confirmText={t('common.confirm')}
            cancelText={t('common.cancel')}
            destructive
            onConfirm={() => {
              setShowCloseConfirm(false);
              startTabCloseAnimation(instanceId);
            }}
            onCancel={() => setShowCloseConfirm(false)}
          />
        </div>
      )}

      {/* 全屏模态框 */}
      {isFullscreen && screenshotUrl && (
        <div
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-8"
          onClick={toggleFullscreen}
        >
          {/* 卡片容器 */}
          <div
            className="mxu-overlay-surface relative bg-bg-secondary rounded-xl border border-border shadow-2xl max-w-[90vw] max-h-[90vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
            onContextMenu={handleContextMenu}
          >
            {/* 卡片标题栏 */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-bg-tertiary/50">
              <div className="flex items-center gap-2">
                <Monitor className="w-4 h-4 text-text-secondary" />
                <span className="text-sm font-medium text-text-primary">{instanceName}</span>
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
            <div className="p-4 bg-bg-primary flex items-center justify-center overflow-auto">
              <img
                src={screenshotUrl}
                alt="Screenshot"
                className="max-w-full max-h-[calc(90vh-80px)] object-contain rounded-md"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface DashboardViewProps {
  onClose?: () => void;
}

export function DashboardView({ onClose }: DashboardViewProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const {
    instances,
    activeInstanceId,
    setActiveInstance,
    createInstance,
    toggleDashboardView,
  } = useAppStore();

  // 实例网格对齐方式：left / center / right
  const [align, setAlign] = useState<'left' | 'center' | 'right'>('center');
  // 实例网格缩放
  const [zoom, setZoom] = useState(1);

  const handleZoom = (delta: number) => {
    setZoom((prev) => {
      const next = Math.min(1.5, Math.max(0.6, prev + delta));
      return Math.round(next * 100) / 100;
    });
  };

  const handleClose = onClose ?? toggleDashboardView;

  const handleSelectInstance = (instanceId: string) => {
    setActiveInstance(instanceId);
    handleClose();
  };

  return (
    <div className="h-full flex flex-col bg-bg-primary overflow-hidden">
      {/* 实例网格 */}
      <div className="flex-1 overflow-auto p-3 sm:p-6">
        {instances.length === 0 ? (
          <div className="h-full flex items-center justify-center text-text-muted">
            <p>{t('dashboard.noInstances')}</p>
          </div>
        ) : (
          <div
            className={clsx(
              'w-full flex',
              align === 'left' && 'justify-start',
              align === 'center' && 'justify-center',
              align === 'right' && 'justify-end',
            )}
          >
            <div
              className={clsx(
                'grid gap-4 w-full',
                instances.length === 1
                  ? 'grid-cols-1 max-w-2xl'
                  : instances.length === 2
                    ? 'grid-cols-1 sm:grid-cols-2 max-w-4xl'
                    : instances.length <= 4
                      ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 max-w-5xl'
                      : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4',
              )}
              style={
                {
                  transform: `scale(${zoom})`,
                  transformOrigin:
                    align === 'left' ? 'top left' : align === 'right' ? 'top right' : 'top center',
                } as CSSProperties
              }
            >
              {instances.map((instance) => (
                <InstanceCard
                  key={instance.id}
                  instanceId={instance.id}
                  instanceName={instance.name}
                  isActive={instance.id === activeInstanceId}
                  onSelect={() => handleSelectInstance(instance.id)}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 底部工具栏 */}
      <div className="flex items-center justify-between px-3 py-2.5 sm:px-6 sm:py-4 flex-wrap gap-2 border-t border-border bg-bg-secondary">
        <div className="flex items-center gap-2 sm:gap-3">
          <LayoutGrid className="w-5 h-5 text-accent" />
          <h1 className="text-base sm:text-lg font-semibold text-text-primary">
            {t('dashboard.title')}
          </h1>
          <span className="px-2 py-0.5 text-xs bg-accent/10 text-accent rounded-full">
            {instances.length} {t('dashboard.instances')}
          </span>
          <button
            type="button"
            onClick={() => createInstance(t('instance.defaultName'))}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg bg-accent/15 text-accent hover:bg-accent/25 active:bg-accent/30 transition-colors"
            title={t('titleBar.newTab')}
          >
            <Plus className="w-3.5 h-3.5" />
            <span>{t('titleBar.newTab')}</span>
          </button>
        </div>

        {/* 中间：排列 + 缩放（放在底部中间区域，窄屏隐藏避免拥挤） */}
        <div className="hidden sm:flex items-center justify-center gap-4">
          {/* 对齐方式切换 */}
          <div className="flex items-center gap-1 bg-bg-tertiary rounded-md px-1.5 py-1">
            <button
              type="button"
              onClick={() => setAlign('left')}
              className={clsx(
                'p-1.5 rounded-md text-xs flex items-center justify-center',
                align === 'left' ? 'bg-accent text-white' : 'text-text-secondary hover:bg-bg-hover',
              )}
              title={t('dashboard.alignLeft')}
            >
              <AlignLeft className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => setAlign('center')}
              className={clsx(
                'p-1.5 rounded-md text-xs flex items-center justify-center',
                align === 'center'
                  ? 'bg-accent text-white'
                  : 'text-text-secondary hover:bg-bg-hover',
              )}
              title={t('dashboard.alignCenter')}
            >
              <AlignCenter className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => setAlign('right')}
              className={clsx(
                'p-1.5 rounded-md text-xs flex items-center justify-center',
                align === 'right'
                  ? 'bg-accent text-white'
                  : 'text-text-secondary hover:bg-bg-hover',
              )}
              title={t('dashboard.alignRight')}
            >
              <AlignRight className="w-4 h-4" />
            </button>
          </div>

          {/* 缩放调整 */}
          <div className="flex items-center gap-1 bg-bg-tertiary rounded-md px-1.5 py-1">
            <button
              type="button"
              onClick={() => handleZoom(-0.1)}
              className="p-1.5 rounded-md text-xs flex items-center justify-center text-text-secondary hover:bg-bg-hover"
              title={t('dashboard.zoomOut')}
            >
              <ZoomOut className="w-4 h-4" />
            </button>
            <span className="px-1 text-xs text-text-secondary w-10 text-center select-none">
              {Math.round(zoom * 100)}%
            </span>
            <button
              type="button"
              onClick={() => handleZoom(0.1)}
              className="p-1.5 rounded-md text-xs flex items-center justify-center text-text-secondary hover:bg-bg-hover"
              title={t('dashboard.zoomIn')}
            >
              <ZoomIn className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* 右侧：帧率 + 退出按钮（移动端已有底部常驻导航栏，隐藏冗余退出按钮） */}
        <div className="flex items-center gap-4">
          <FrameRateSelector compact />
          {!isMobile && (
            <button
              onClick={handleClose}
              className="px-3 py-1.5 text-sm bg-bg-hover hover:bg-bg-active text-text-secondary rounded-lg transition-colors"
            >
              {t('dashboard.exit')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
