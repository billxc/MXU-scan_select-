import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import clsx from 'clsx';

export interface MobileSheetProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  icon?: ReactNode;
  headerActions?: ReactNode;
  children: ReactNode;
  /** 面板最大高度类名，默认 max-h-[85dvh] */
  maxHeightClassName?: string;
  /** 面板固定高度类名（如 h-[80dvh]），可选 */
  heightClassName?: string;
  /** 内容容器自定义类名 */
  bodyClassName?: string;
  /** z-index 类名，默认 z-[10050] */
  zIndexClassName?: string;
}

/**
 * 移动端通用 Bottom Sheet 底部抽屉容器：
 * - 通过 Portal 挂载到 document.body，不受局部 transform / overflow / Fixed 定位裁切影响
 * - 自动处理底部安全区 env(safe-area-inset-bottom)、ESC 关闭与遮罩点击关闭
 * - 供 OptionEditor、TaskItem、AddTaskPanel、ConnectionPanel、SchedulePanel、RecentlyClosedPanel 等统一复用
 */
export function MobileSheet({
  open,
  onClose,
  title,
  icon,
  headerActions,
  children,
  maxHeightClassName = 'max-h-[85dvh]',
  heightClassName,
  bodyClassName,
  zIndexClassName = 'z-[10050]',
}: MobileSheetProps) {
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open || typeof document === 'undefined') return null;

  const hasHeader = title !== undefined || icon !== undefined || headerActions !== undefined;

  return createPortal(
    <div
      className={clsx(
        'fixed inset-0 bg-black/50 backdrop-blur-xs flex flex-col justify-end animate-in fade-in duration-150',
        zIndexClassName,
      )}
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      onContextMenu={(e) => {
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
      }}
    >
      <div
        className={clsx(
          'mxu-overlay-surface w-full bg-bg-secondary rounded-t-2xl border-t border-border shadow-2xl flex flex-col overflow-hidden pb-[env(safe-area-inset-bottom)]',
          maxHeightClassName,
          heightClassName,
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 顶部拖拽指示条与可选标题栏 */}
        <div
          className={clsx(
            'flex flex-col items-center pt-2 shrink-0 bg-bg-secondary',
            hasHeader ? 'pb-2 px-4 border-b border-border' : 'pb-1',
          )}
        >
          <div className="w-10 h-1 rounded-full bg-border-strong/60 mb-1.5" />
          {hasHeader && (
            <div className="w-full flex items-center justify-between gap-2">
              <div className="min-w-0 flex-1 flex items-center gap-2">
                {icon && <span className="shrink-0 text-accent flex items-center">{icon}</span>}
                {typeof title === 'string' ? (
                  <span className="text-base font-semibold text-text-primary truncate">
                    {title}
                  </span>
                ) : (
                  title
                )}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {headerActions}
                <button
                  type="button"
                  onClick={onClose}
                  className="p-1.5 rounded-full text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors"
                  aria-label="Close"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>
          )}
        </div>

        {/* 抽屉内容区 */}
        <div className={clsx('flex-1 min-h-0 flex flex-col overflow-hidden', bodyClassName)}>
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
