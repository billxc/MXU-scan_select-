import { useState, useCallback, useRef, useEffect, Suspense, lazy } from 'react';
import { useTranslation } from 'react-i18next';
import { resolveThemeMode } from '@/themes';
import {
  Plus,
  X,
  Settings,
  Sun,
  Moon,
  Check,
  LayoutGrid,
  Copy,
  Edit3,
  XCircle,
  GripVertical,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  ChevronsLeft,
  ChevronsRight,
  PanelRightClose,
  Bell,
  History,
  Share2,
  FileText,
  Download,
  MoreHorizontal,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { useAppStore } from '@/stores/appStore';
import { ContextMenu, useContextMenu, type MenuItem } from './ContextMenu';
import { ConfirmDialog } from './ConfirmDialog';
import { MobileSheet } from './ui/MobileSheet';
import { getInterfaceLangKey } from '@/i18n';
import { exportFileWithToast, exportWithToast } from '@/utils/tabExportImport';
import { isTauri } from '@/utils/paths';
import { usePwaInstall } from '@/utils/pwa';
import { useIsMobile } from '@/hooks/useIsMobile';
import clsx from 'clsx';

type CloseConfirmData =
  | { type: 'single'; ids: string[]; name: string }
  | { type: 'multi'; ids: string[] }
  | null;

const LazyUpdatePanel = lazy(async () => {
  const module = await import('./UpdatePanel');
  return { default: module.UpdatePanel };
});

const LazyRecentlyClosedPanel = lazy(async () => {
  const module = await import('./RecentlyClosedPanel');
  return { default: module.RecentlyClosedPanel };
});

export function TabBar() {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [closeConfirm, setCloseConfirm] = useState<CloseConfirmData>(null);
  const [dragState, setDragState] = useState<{
    isDragging: boolean;
    draggedIndex: number;
    dragOverIndex: number | null;
  }>({ isDragging: false, draggedIndex: -1, dragOverIndex: null });
  const [showRecentlyClosedPanel, setShowRecentlyClosedPanel] = useState(false);
  const [showInstanceSheet, setShowInstanceSheet] = useState(false);
  const tabRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const bellButtonRef = useRef<HTMLButtonElement>(null);
  const recentlyClosedButtonRef = useRef<HTMLButtonElement>(null);

  const {
    instances,
    activeInstanceId,
    createInstance,
    setActiveInstance,
    renameInstance,
    reorderInstances,
    duplicateInstance,
    theme,
    setTheme,
    setCurrentPage,
    projectInterface,
    resolveI18nText,
    language,
    dashboardView,
    toggleDashboardView,
    updateInfo,
    recentlyClosed,
    downloadStatus,
    showUpdateDialog,
    setShowUpdateDialog,
    animatingTabIds,
    closingTabIds,
    removeAnimatingTabId,
    startTabCloseAnimation,
    confirmBeforeDelete,
    instanceConnectionStatus,
  } = useAppStore();

  const activeInstance = instances.find((i) => i.id === activeInstanceId) ?? instances[0];
  const activeInstanceIndex = Math.max(
    0,
    instances.findIndex((i) => i.id === activeInstance?.id),
  );
  const isActiveConnected =
    activeInstance ? instanceConnectionStatus[activeInstance.id] === 'Connected' : false;

  // 使用全局状态控制更新面板显示
  const showUpdatePanel = showUpdateDialog;
  const setShowUpdatePanel = setShowUpdateDialog;

  const { state: menuState, showAt: showMenuAt, hide: hideMenu } = useContextMenu();
  const { canInstall, isStandalone, promptInstall } = usePwaInstall();

  const handleInstallPwa = async () => {
    const res = await promptInstall();
    if (res === 'ios-manual') {
      toast.info('iOS 请点击浏览器底部分享按钮，选择「添加到主屏幕」以安装全屏应用');
    }
  };

  // 当最近关闭列表为空时，自动关闭面板
  useEffect(() => {
    if (recentlyClosed.length === 0) {
      setShowRecentlyClosedPanel(false);
    }
  }, [recentlyClosed.length]);

  // 切换或新建实例时，确保当前激活标签滚动到水平可视区域内
  useEffect(() => {
    if (!activeInstanceId) return;
    const el = tabRefs.current.get(activeInstanceId);
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }, [activeInstanceId, instances.length]);

  const handleNewTab = () => {
    createInstance(t('instance.defaultName'));
  };

  const requestCloseTabs = (ids: string[], name?: string) => {
    if (confirmBeforeDelete) {
      if (name !== undefined) {
        setCloseConfirm({ type: 'single', ids, name });
      } else {
        setCloseConfirm({ type: 'multi', ids });
      }
    } else {
      ids.forEach((id) => startTabCloseAnimation(id));
    }
  };

  const handleCloseTab = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (instances.length > 1) {
      const instance = instances.find((inst) => inst.id === id);
      if (instance) {
        requestCloseTabs([id], instance.name);
      }
    }
  };

  const handleConfirmClose = () => {
    if (closeConfirm) {
      closeConfirm.ids.forEach((id) => {
        startTabCloseAnimation(id);
      });
      setCloseConfirm(null);
    }
  };

  const handleCancelClose = () => {
    setCloseConfirm(null);
  };

  const handleDoubleClick = (e: React.MouseEvent, id: string, name: string) => {
    e.stopPropagation();
    setEditingId(id);
    setEditName(name);
  };

  const handleSaveEdit = () => {
    if (editingId && editName.trim()) {
      renameInstance(editingId, editName.trim());
    }
    setEditingId(null);
    setEditName('');
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditName('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSaveEdit();
    } else if (e.key === 'Escape') {
      handleCancelEdit();
    }
  };

  const toggleTheme = () => {
    const currentMode = resolveThemeMode(theme);
    setTheme(currentMode === 'light' ? 'dark' : 'light');
  };

  const langKey = getInterfaceLangKey(language);

  // 右键菜单处理
  const handleTabContextMenu = useCallback(
    async (
      e: React.MouseEvent,
      instanceId: string,
      instanceName: string,
      anchorPosition?: { x: number; y: number },
    ) => {
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
      const position = anchorPosition ?? { x: e.clientX, y: e.clientY };
      const instanceIndex = instances.findIndex((i) => i.id === instanceId);
      const isFirst = instanceIndex === 0;
      const isLast = instanceIndex === instances.length - 1;
      const inst = instances.find((i) => i.id === instanceId);
      const projectName = projectInterface?.name;
      const exportHint =
        inst && projectName ? t('preset.exportShareHint', { projectName, tabName: inst.name }) : '';
      const exportFooter = projectName ? t('preset.exportShareFooter', { projectName }) : '';

      const menuItems: MenuItem[] = [
        {
          id: 'new',
          label: t('contextMenu.newTab'),
          icon: Plus,
          onClick: () => createInstance(t('instance.defaultName')),
        },
        {
          id: 'duplicate',
          label: t('contextMenu.duplicateTab'),
          icon: Copy,
          onClick: () => duplicateInstance(instanceId),
        },
        {
          id: 'export',
          label: t('contextMenu.exportConfig'),
          icon: Share2,
          disabled: !inst || !projectName,
          children: [
            {
              id: 'export-clipboard',
              label: t('contextMenu.exportToClipboard'),
              icon: Copy,
              onClick: () => {
                if (inst && projectName) {
                  exportWithToast(inst, projectName, exportHint, exportFooter, {
                    success: t('preset.exportSuccess'),
                    failed: t('preset.exportFailed'),
                  });
                }
              },
            },
            {
              id: 'export-file',
              label: t('contextMenu.exportToTxt'),
              icon: FileText,
              onClick: () => {
                if (inst && projectName) {
                  exportFileWithToast(inst, projectName, exportHint, exportFooter, {
                    success: t('preset.exportFileSuccess'),
                    failed: t('preset.exportFileFailed'),
                  });
                }
              },
            },
          ],
        },
        {
          id: 'rename',
          label: t('contextMenu.renameTab'),
          icon: Edit3,
          onClick: () => {
            setEditingId(instanceId);
            setEditName(instanceName);
          },
        },
        { id: 'divider-1', label: '', divider: true },
        {
          id: 'move-left',
          label: t('contextMenu.moveLeft'),
          icon: ChevronLeft,
          disabled: isFirst,
          onClick: () => reorderInstances(instanceIndex, instanceIndex - 1),
        },
        {
          id: 'move-right',
          label: t('contextMenu.moveRight'),
          icon: ChevronRight,
          disabled: isLast,
          onClick: () => reorderInstances(instanceIndex, instanceIndex + 1),
        },
        {
          id: 'move-first',
          label: t('contextMenu.moveToFirst'),
          icon: ChevronsLeft,
          disabled: isFirst,
          onClick: () => reorderInstances(instanceIndex, 0),
        },
        {
          id: 'move-last',
          label: t('contextMenu.moveToLast'),
          icon: ChevronsRight,
          disabled: isLast,
          onClick: () => reorderInstances(instanceIndex, instances.length - 1),
        },
        { id: 'divider-2', label: '', divider: true },
        {
          id: 'close',
          label: t('contextMenu.closeTab'),
          icon: X,
          disabled: instances.length <= 1,
          onClick: () => {
            const inst = instances.find((i) => i.id === instanceId);
            if (inst) requestCloseTabs([instanceId], inst.name);
          },
        },
        {
          id: 'close-others',
          label: t('contextMenu.closeOtherTabs'),
          icon: XCircle,
          disabled: instances.length <= 1,
          onClick: () => {
            const instanceIdsWithoutCurrent = instances
              .map((inst) => inst.id)
              .filter((id) => id !== instanceId);
            requestCloseTabs(instanceIdsWithoutCurrent);
          },
        },
        {
          id: 'close-right',
          label: t('contextMenu.closeTabsToRight'),
          icon: PanelRightClose,
          disabled: instanceIndex >= instances.length - 1,
          onClick: () => {
            const rightInstanceIds = instances.slice(instanceIndex + 1).map((inst) => inst.id);
            requestCloseTabs(rightInstanceIds);
          },
        },
      ];

      showMenuAt(position, menuItems);
    },
    [
      instances,
      t,
      createInstance,
      duplicateInstance,
      reorderInstances,
      showMenuAt,
      projectInterface,
      confirmBeforeDelete,
      startTabCloseAnimation,
    ],
  );

  // 基于鼠标事件的拖拽实现（更可靠，兼容 Tauri）
  const handleMouseDown = useCallback((e: React.MouseEvent, index: number) => {
    // 只响应拖拽手柄的点击
    if (!(e.target as HTMLElement).closest('.drag-handle')) return;

    e.preventDefault();
    setDragState({ isDragging: true, draggedIndex: index, dragOverIndex: null });
  }, []);

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!dragState.isDragging) return;

      // 找出鼠标当前位置对应的标签索引
      let newDragOverIndex: number | null = null;
      tabRefs.current.forEach((el, id) => {
        const rect = el.getBoundingClientRect();
        if (e.clientX >= rect.left && e.clientX <= rect.right) {
          const idx = instances.findIndex((inst) => inst.id === id);
          if (idx !== -1 && idx !== dragState.draggedIndex) {
            newDragOverIndex = idx;
          }
        }
      });

      if (newDragOverIndex !== dragState.dragOverIndex) {
        setDragState((prev) => ({ ...prev, dragOverIndex: newDragOverIndex }));
      }
    },
    [dragState.isDragging, dragState.draggedIndex, dragState.dragOverIndex, instances],
  );

  const handleMouseUp = useCallback(() => {
    if (!dragState.isDragging) return;

    if (dragState.dragOverIndex !== null && dragState.draggedIndex !== dragState.dragOverIndex) {
      reorderInstances(dragState.draggedIndex, dragState.dragOverIndex);
    }
    setDragState({ isDragging: false, draggedIndex: -1, dragOverIndex: null });
  }, [dragState, reorderInstances]);

  // 全局鼠标事件监听
  useEffect(() => {
    if (dragState.isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [dragState.isDragging, handleMouseMove, handleMouseUp]);

  return (
    <div className="flex items-center h-10 bg-bg-secondary border-b border-border select-none">
      {/* 移动端：使用原生风顶部栏 + 实例切换抽屉（替代传统浏览器多标签滚动条）；桌面端：保持原有横向标签栏 */}
      {isMobile ? (
        dashboardView ? (
          <div className="flex-1 flex items-center gap-2 px-3 h-full min-w-0">
            <LayoutGrid className="w-4 h-4 text-accent flex-shrink-0" />
            <span className="text-sm font-medium text-text-primary truncate">
              {t('dashboard.title')}
            </span>
            <span className="px-1.5 py-0.5 text-[11px] bg-accent/10 text-accent rounded-full flex-shrink-0">
              {instances.length}
            </span>
          </div>
        ) : (
          <div className="flex-1 flex items-center gap-1.5 px-2.5 h-full min-w-0">
            {activeInstance && editingId === activeInstance.id ? (
              <div
                className="flex-1 flex items-center gap-1 min-w-0"
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onBlur={handleSaveEdit}
                  autoFocus
                  className={clsx(
                    'flex-1 min-w-0 px-2 py-1 text-sm rounded-md border border-accent',
                    'bg-bg-primary text-text-primary',
                    'focus:outline-none',
                  )}
                />
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleSaveEdit();
                  }}
                  className="p-1 rounded-md hover:bg-success/10 text-success flex-shrink-0"
                >
                  <Check className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleCancelEdit();
                  }}
                  className="p-1 rounded-md hover:bg-error/10 text-error flex-shrink-0"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setShowInstanceSheet(true)}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-bg-tertiary/90 active:bg-bg-hover border border-border/80 min-w-0 max-w-[220px] transition-colors"
                  title={t('dashboard.title')}
                >
                  {activeInstance?.isRunning ? (
                    <span className="w-2 h-2 rounded-full bg-accent task-running-indicator flex-shrink-0" />
                  ) : (
                    <span
                      className={clsx(
                        'w-2 h-2 rounded-full flex-shrink-0',
                        isActiveConnected ? 'bg-success' : 'bg-text-muted/50',
                      )}
                    />
                  )}
                  <span className="text-sm font-medium text-text-primary truncate">
                    {activeInstance?.name || 'MXU'}
                  </span>
                  {instances.length > 1 && (
                    <span className="px-1.5 py-0.2 text-[10px] font-medium rounded-full bg-accent/12 text-accent flex-shrink-0">
                      {activeInstanceIndex + 1}/{instances.length}
                    </span>
                  )}
                  <ChevronDown className="w-3.5 h-3.5 text-text-secondary flex-shrink-0" />
                </button>

                {activeInstance && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      const rect = e.currentTarget.getBoundingClientRect();
                      void handleTabContextMenu(e, activeInstance.id, activeInstance.name, {
                        x: rect.left,
                        y: rect.bottom + 4,
                      });
                    }}
                    className="p-1.5 rounded-md text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors flex-shrink-0"
                    title={t('common.edit')}
                  >
                    <MoreHorizontal className="w-4 h-4" />
                  </button>
                )}
              </>
            )}
          </div>
        )
      ) : (
        <div id="tab-bar-area" className="flex-1 flex items-center h-full overflow-x-auto">
        {instances.map((instance, index) => {
          const isAnimatingIn = animatingTabIds.includes(instance.id);
          const isClosing = closingTabIds.includes(instance.id);

          return (
            <div
              key={instance.id}
              ref={(el) => {
                if (el) tabRefs.current.set(instance.id, el);
                else tabRefs.current.delete(instance.id);
              }}
              onMouseDown={(e) => handleMouseDown(e, index)}
              onClick={() => !isClosing && setActiveInstance(instance.id)}
              onDoubleClick={(e) => handleDoubleClick(e, instance.id, instance.name)}
              onContextMenu={
                isMobile ? undefined : (e) => handleTabContextMenu(e, instance.id, instance.name)
              }
              onAnimationEnd={() => {
                if (isAnimatingIn) {
                  removeAnimatingTabId(instance.id);
                }
              }}
              className={clsx(
                'group flex items-center gap-1 h-full px-2 cursor-pointer border-r border-border max-w-[180px] sm:max-w-[200px]',
                editingId === instance.id
                  ? 'min-w-[160px] sm:min-w-[160px]'
                  : 'min-w-[96px] sm:min-w-[120px]',
                instance.id === activeInstanceId
                  ? 'bg-bg-primary text-accent border-b-2 border-b-accent'
                  : 'bg-bg-tertiary text-text-secondary hover:bg-bg-hover border-b-2 border-b-transparent',
                dragState.isDragging &&
                  dragState.draggedIndex === index &&
                  'opacity-50 bg-accent/10',
                dragState.isDragging &&
                  dragState.dragOverIndex === index &&
                  'border-l-2 border-l-accent',
                isAnimatingIn && 'tab-fade-in',
                isClosing && 'tab-fade-out',
                !isAnimatingIn && !isClosing && 'transition-all',
              )}
            >
              {/* 拖拽手柄 - 单标签时禁用，移动端隐藏节省空间 */}
              {editingId !== instance.id && (
                <div
                  className={clsx(
                    'hidden sm:block drag-handle p-0.5 transition-opacity',
                    instances.length > 1
                      ? 'cursor-grab opacity-0 group-hover:opacity-60 hover:!opacity-100'
                      : 'cursor-not-allowed opacity-30',
                  )}
                  title={instances.length > 1 ? t('titleBar.dragToReorder') : undefined}
                >
                  <GripVertical className="w-3 h-3" />
                </div>
              )}

              {editingId === instance.id ? (
                <div
                  className="flex-1 flex items-center gap-1"
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={handleKeyDown}
                    onBlur={handleSaveEdit}
                    autoFocus
                    className={clsx(
                      'flex-1 w-full px-1 py-0.5 text-sm rounded border border-accent',
                      'bg-bg-primary text-text-primary',
                      'focus:outline-none',
                    )}
                  />
                  <button
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      handleSaveEdit();
                    }}
                    className="p-0.5 rounded hover:bg-success/10 text-success"
                  >
                    <Check className="w-3 h-3" />
                  </button>
                  <button
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      handleCancelEdit();
                    }}
                    className="p-0.5 rounded hover:bg-error/10 text-error"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ) : (
                <>
                  {instance.isRunning && (
                    <span className="w-2 h-2 rounded-full bg-accent task-running-indicator flex-shrink-0" />
                  )}
                  <span className="flex-1 truncate text-sm" title={t('titleBar.renameInstance')}>
                    {instance.name}
                  </span>
                  {instance.id === activeInstanceId && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        const rect = e.currentTarget.getBoundingClientRect();
                        void handleTabContextMenu(e, instance.id, instance.name, {
                          x: rect.left,
                          y: rect.bottom + 4,
                        });
                      }}
                      className="sm:hidden p-1 rounded text-text-muted hover:bg-bg-hover hover:text-text-primary transition-colors flex-shrink-0"
                      title={t('common.edit')}
                    >
                      <MoreHorizontal className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {!isClosing && (
                    <button
                      onClick={(e) => handleCloseTab(e, instance.id)}
                      disabled={instances.length <= 1}
                      className={clsx(
                        'hidden sm:inline-flex p-0.5 rounded transition-all',
                        instances.length > 1
                          ? clsx(
                              'text-text-muted hover:bg-error/10 hover:text-error',
                              instance.id === activeInstanceId
                                ? 'opacity-100 sm:opacity-0 sm:group-hover:opacity-100'
                                : 'opacity-0 group-hover:opacity-100',
                            )
                          : 'opacity-30 cursor-not-allowed',
                      )}
                      title={instances.length > 1 ? t('titleBar.closeTab') : undefined}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </>
              )}
            </div>
          );
        })}

        {/* 新建标签按钮 */}
        <button
          onClick={handleNewTab}
          className="flex items-center justify-center w-8 h-full hover:bg-bg-hover transition-colors"
          title={t('titleBar.newTab')}
        >
          <Plus className="w-4 h-4 text-text-secondary" />
        </button>
      </div>
      )}

      {/* 项目名称（根据协议，label 是 UI 显示名称，title 是窗口标题；移动端隐藏节省空间） */}
      <div className="hidden md:block px-4 text-sm font-medium text-text-secondary">
        {resolveI18nText(projectInterface?.label, langKey) || projectInterface?.name || 'MXU'}
      </div>

      {/* 工具按钮 */}
      <div className="flex items-center gap-1 px-2">
        {/* 更新通知图标 - 有更新、正在下载或有错误时显示 */}
        {(updateInfo?.hasUpdate || updateInfo?.errorCode || downloadStatus === 'downloading') && (
          <button
            ref={bellButtonRef}
            onClick={() => setShowUpdatePanel(!showUpdatePanel)}
            className={clsx(
              'relative p-2 rounded-md transition-colors',
              showUpdatePanel ? 'bg-accent/10' : 'hover:bg-bg-hover',
            )}
            title={
              updateInfo?.hasUpdate
                ? t('mirrorChyan.newVersion')
                : updateInfo?.errorCode
                  ? t('mirrorChyan.checkFailed')
                  : t('mirrorChyan.newVersion')
            }
          >
            <Bell
              className={clsx(
                'w-4 h-4',
                // 有错误码时用 warning 色，否则用 accent 色
                updateInfo?.errorCode ? 'text-warning' : 'text-accent',
                !showUpdatePanel && 'animate-bell-shake',
              )}
            />
            {!showUpdatePanel && (
              <span
                className={clsx(
                  'absolute top-1 right-1 w-2 h-2 rounded-full animate-pulse',
                  // 有更新用 error 色（紧急），仅有错误用 warning 色（提示）
                  updateInfo?.hasUpdate ? 'bg-error' : 'bg-warning',
                )}
              />
            )}
          </button>
        )}
        {/* 最近关闭按钮 - 仅在有记录时显示 */}
        {recentlyClosed.length > 0 && (
          <button
            ref={recentlyClosedButtonRef}
            onClick={() => setShowRecentlyClosedPanel(!showRecentlyClosedPanel)}
            className={clsx(
              'p-2 rounded-md transition-colors',
              showRecentlyClosedPanel
                ? 'bg-accent/10 text-accent'
                : 'hover:bg-bg-hover text-text-secondary',
            )}
            title={t('recentlyClosed.title')}
          >
            <History className="w-4 h-4" />
          </button>
        )}
        <button
          onClick={toggleDashboardView}
          className={clsx(
            'hidden md:inline-flex p-2 rounded-md transition-colors',
            dashboardView ? 'bg-accent/10 text-accent' : 'hover:bg-bg-hover text-text-secondary',
          )}
          title={t('dashboard.toggle')}
        >
          <LayoutGrid className="w-4 h-4" />
        </button>
        {!isTauri() && canInstall && !isStandalone && (
          <button
            onClick={handleInstallPwa}
            className="p-2 rounded-md hover:bg-bg-hover text-text-secondary hover:text-accent transition-colors"
            title="安装应用"
          >
            <Download className="w-4 h-4" />
          </button>
        )}
        <button
          onClick={toggleTheme}
          className="p-2 rounded-md hover:bg-bg-hover transition-colors"
          title={
            resolveThemeMode(theme) === 'light' ? t('settings.themeDark') : t('settings.themeLight')
          }
        >
          {resolveThemeMode(theme) === 'light' ? (
            <Moon className="w-4 h-4 text-text-secondary" />
          ) : (
            <Sun className="w-4 h-4 text-text-secondary" />
          )}
        </button>
        <button
          onClick={() => setCurrentPage('settings')}
          className="hidden md:inline-flex p-2 rounded-md hover:bg-bg-hover transition-colors"
          title={t('titleBar.settings')}
        >
          <Settings className="w-4 h-4 text-text-secondary" />
        </button>
      </div>

      {/* 右键菜单 */}
      {menuState.isOpen && (
        <ContextMenu items={menuState.items} position={menuState.position} onClose={hideMenu} />
      )}

      {/* 更新面板 */}
      {showUpdatePanel && (
        <Suspense fallback={null}>
          <LazyUpdatePanel onClose={() => setShowUpdatePanel(false)} anchorRef={bellButtonRef} />
        </Suspense>
      )}

      {/* 最近关闭面板 */}
      {showRecentlyClosedPanel && (
        <Suspense fallback={null}>
          <LazyRecentlyClosedPanel
            onClose={() => setShowRecentlyClosedPanel(false)}
            anchorRef={recentlyClosedButtonRef}
          />
        </Suspense>
      )}

      {/* 移动端：实例切换与管理抽屉 */}
      {isMobile && (
        <MobileSheet
          open={showInstanceSheet}
          onClose={() => {
            setShowInstanceSheet(false);
            if (editingId) {
              handleCancelEdit();
            }
          }}
          icon={<LayoutGrid className="w-4 h-4" />}
          title={
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-base font-semibold text-text-primary truncate">
                {t('dashboard.title')}
              </span>
              <span className="px-1.5 py-0.5 text-xs bg-accent/12 text-accent rounded-full">
                {instances.length}
              </span>
            </div>
          }
          headerActions={
            <button
              type="button"
              onClick={() => {
                handleNewTab();
              }}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-accent/15 text-accent active:bg-accent/25 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{t('titleBar.newTab')}</span>
            </button>
          }
        >
          <div className="overflow-y-auto flex-1 min-h-0 p-3 space-y-2">
            {instances.map((inst, idx) => {
              const isSelected = inst.id === activeInstanceId;
              const isInstConnected = instanceConnectionStatus[inst.id] === 'Connected';
              const isEditingThis = editingId === inst.id;

              return (
                <div
                  key={inst.id}
                  onClick={() => {
                    if (isEditingThis) return;
                    setActiveInstance(inst.id);
                    setShowInstanceSheet(false);
                  }}
                  className={clsx(
                    'flex items-center justify-between gap-2 px-3.5 py-3 rounded-xl border transition-colors cursor-pointer',
                    isSelected
                      ? 'bg-accent/10 border-accent text-text-primary'
                      : 'bg-bg-tertiary/60 border-border text-text-primary active:bg-bg-hover',
                  )}
                >
                  {isEditingThis ? (
                    <div
                      className="flex-1 flex items-center gap-1.5 min-w-0"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={handleKeyDown}
                        onBlur={handleSaveEdit}
                        autoFocus
                        className="flex-1 min-w-0 px-2.5 py-1.5 text-base rounded-lg border border-accent bg-bg-primary text-text-primary focus:outline-none"
                      />
                      <button
                        type="button"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleSaveEdit();
                        }}
                        className="p-1.5 rounded-lg bg-success/15 text-success"
                      >
                        <Check className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleCancelEdit();
                        }}
                        className="p-1.5 rounded-lg bg-error/15 text-error"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-2.5 min-w-0 flex-1">
                        {inst.isRunning ? (
                          <span className="w-2.5 h-2.5 rounded-full bg-accent task-running-indicator flex-shrink-0" />
                        ) : (
                          <span
                            className={clsx(
                              'w-2.5 h-2.5 rounded-full flex-shrink-0',
                              isInstConnected ? 'bg-success' : 'bg-text-muted/50',
                            )}
                          />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span
                              className={clsx(
                                'text-base truncate',
                                isSelected ? 'font-semibold text-accent' : 'font-medium',
                              )}
                            >
                              {inst.name}
                            </span>
                            {inst.isRunning && (
                              <span className="px-1.5 py-0.5 text-[10px] rounded bg-accent/15 text-accent font-medium flex-shrink-0">
                                {t('dashboard.running')}
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-text-muted truncate mt-0.5">
                            {inst.selectedTasks.filter((task) => task.enabled || task.runOnce).length}/
                            {inst.selectedTasks.length} {t('preset.taskCount')}
                          </div>
                        </div>
                      </div>

                      <div
                        className="flex items-center gap-0.5 shrink-0"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {instances.length > 1 && (
                          <>
                            <button
                              type="button"
                              disabled={idx === 0}
                              onClick={() => reorderInstances(idx, idx - 1)}
                              className={clsx(
                                'p-1.5 rounded-lg transition-colors',
                                idx === 0
                                  ? 'text-text-muted/30 cursor-not-allowed'
                                  : 'text-text-secondary hover:bg-bg-hover active:bg-bg-active',
                              )}
                              title={t('contextMenu.moveLeft')}
                            >
                              <ChevronUp className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              disabled={idx === instances.length - 1}
                              onClick={() => reorderInstances(idx, idx + 1)}
                              className={clsx(
                                'p-1.5 rounded-lg transition-colors',
                                idx === instances.length - 1
                                  ? 'text-text-muted/30 cursor-not-allowed'
                                  : 'text-text-secondary hover:bg-bg-hover active:bg-bg-active',
                              )}
                              title={t('contextMenu.moveRight')}
                            >
                              <ChevronDown className="w-4 h-4" />
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            setEditingId(inst.id);
                            setEditName(inst.name);
                          }}
                          className="p-1.5 rounded-lg text-text-secondary hover:bg-bg-hover active:bg-bg-active transition-colors"
                          title={t('contextMenu.renameTab')}
                        >
                          <Edit3 className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => duplicateInstance(inst.id)}
                          className="p-1.5 rounded-lg text-text-secondary hover:bg-bg-hover active:bg-bg-active transition-colors"
                          title={t('contextMenu.duplicateTab')}
                        >
                          <Copy className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          disabled={instances.length <= 1}
                          onClick={(e) => handleCloseTab(e, inst.id)}
                          className={clsx(
                            'p-1.5 rounded-lg transition-colors',
                            instances.length <= 1
                              ? 'text-text-muted/30 cursor-not-allowed'
                              : 'text-text-muted hover:text-error hover:bg-error/10 active:bg-error/15',
                          )}
                          title={t('contextMenu.closeTab')}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>

          <div className="p-3 pt-2 border-t border-border bg-bg-secondary shrink-0">
            <button
              type="button"
              onClick={() => {
                setShowInstanceSheet(false);
                if (!dashboardView) {
                  toggleDashboardView();
                }
              }}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium bg-bg-tertiary hover:bg-bg-hover active:bg-bg-active text-text-primary border border-border transition-colors"
            >
              <LayoutGrid className="w-4 h-4 text-accent" />
              <span>{t('dashboard.toggle')}</span>
            </button>
          </div>
        </MobileSheet>
      )}

      {/* 关闭标签确认弹窗 */}
      <ConfirmDialog
        open={closeConfirm !== null}
        title={
          closeConfirm?.type === 'multi'
            ? t('titleBar.closeMultiTabConfirmTitle')
            : t('titleBar.closeTabConfirmTitle')
        }
        message={
          closeConfirm?.type === 'multi'
            ? t('titleBar.closeMultiTabConfirmMessage', { count: closeConfirm.ids.length })
            : t('titleBar.closeTabConfirmMessage', { name: closeConfirm?.name ?? '' })
        }
        confirmText={t('common.confirm')}
        cancelText={t('common.cancel')}
        destructive
        onConfirm={handleConfirmClose}
        onCancel={handleCancelClose}
      />
    </div>
  );
}
