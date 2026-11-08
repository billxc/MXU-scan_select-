import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { useIsMobile } from '@/hooks/useIsMobile';
import {
  Plus,
  Copy,
  Trash2,
  Edit3,
  ChevronUp,
  ChevronDown,
  ChevronsUp,
  ChevronsDown,
  Check,
  Square,
  CheckSquare,
  X,
  RefreshCw,
  Maximize2,
  Play,
  Pause,
  Download,
  ChevronRight,
  Unplug,
  FolderOpen,
  SquareCheck,
  SquareMinus,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

// 菜单项类型
export interface MenuItem {
  id: string;
  label: string;
  icon?: LucideIcon;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  checked?: boolean;
  children?: MenuItem[];
  onClick?: () => void;
  divider?: boolean;
}

// 菜单位置
interface MenuPosition {
  x: number;
  y: number;
}

// 右键菜单属性
interface ContextMenuProps {
  items: MenuItem[];
  position: MenuPosition;
  onClose: () => void;
}

// 右键菜单 Hook 返回类型
export interface ContextMenuState {
  isOpen: boolean;
  position: MenuPosition;
  items: MenuItem[];
}

// 图标映射
const iconMap: Record<string, LucideIcon> = {
  plus: Plus,
  copy: Copy,
  trash: Trash2,
  edit: Edit3,
  up: ChevronUp,
  down: ChevronDown,
  toTop: ChevronsUp,
  toBottom: ChevronsDown,
  check: Check,
  uncheck: Square,
  checkSquare: CheckSquare,
  close: X,
  refresh: RefreshCw,
  maximize: Maximize2,
  play: Play,
  pause: Pause,
  download: Download,
  submenu: ChevronRight,
  disconnect: Unplug,
  folder: FolderOpen,
  selectAll: SquareCheck,
  deselectAll: SquareMinus,
};

export function getIcon(name: string): LucideIcon | undefined {
  return iconMap[name];
}

// 单个菜单项组件
function MenuItemComponent({
  item,
  onClose,
  submenuDirection,
  isMobile = false,
  depth = 0,
}: {
  item: MenuItem;
  onClose: () => void;
  submenuDirection: 'left' | 'right';
  isMobile?: boolean;
  depth?: number;
}) {
  const hasChildren = !!item.children?.length;
  const [expanded, setExpanded] = useState(false);

  const handleClick = () => {
    if (item.disabled) return;
    if (hasChildren) {
      setExpanded((prev) => !prev);
      return;
    }
    item.onClick?.();
    onClose();
  };

  if (item.divider) {
    return <div className="my-1 h-px bg-border" />;
  }

  const Icon = item.icon;

  if (isMobile) {
    return (
      <div className={clsx(depth > 0 && 'pl-4')}>
        <button
          onClick={handleClick}
          disabled={item.disabled}
          aria-expanded={hasChildren ? expanded : undefined}
          className={clsx(
            'w-full flex items-center gap-3 px-4 py-3 text-base text-left rounded-xl transition-colors',
            item.disabled
              ? 'text-text-muted opacity-50 cursor-not-allowed'
              : item.danger
                ? 'text-error active:bg-error/10'
                : 'text-text-primary active:bg-bg-hover',
          )}
        >
          {item.checked !== undefined && (
            <span className="w-5 h-5 flex items-center justify-center">
              {item.checked && <Check className="w-4 h-4 text-accent" />}
            </span>
          )}
          {Icon && <Icon className="w-5 h-5 flex-shrink-0" />}
          <span className="flex-1 font-medium">{item.label}</span>
          {hasChildren && (
            <ChevronRight
              className={clsx(
                'w-4 h-4 text-text-muted transition-transform',
                expanded && 'rotate-90',
              )}
            />
          )}
        </button>
        {hasChildren && !item.disabled && expanded && (
          <div className="mt-0.5 mb-1 border-l-2 border-border ml-4 space-y-0.5">
            {item.children!.map((child, index) => (
              <MenuItemComponent
                key={child.divider ? `divider-${index}` : child.id}
                item={child}
                onClose={onClose}
                submenuDirection={submenuDirection}
                isMobile={true}
                depth={depth + 1}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="relative group/menu-item">
      <button
        onClick={handleClick}
        disabled={item.disabled}
        aria-haspopup={hasChildren ? 'menu' : undefined}
        className={clsx(
          'w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left rounded-md transition-colors',
          item.disabled
            ? 'text-text-muted cursor-not-allowed'
            : item.danger
              ? 'text-error hover:bg-error/10'
              : 'text-text-primary hover:bg-bg-hover',
          item.checked !== undefined && 'pl-2',
        )}
      >
        {/* 选中状态图标 */}
        {item.checked !== undefined && (
          <span className="w-4 h-4 flex items-center justify-center">
            {item.checked && <Check className="w-3.5 h-3.5 text-accent" />}
          </span>
        )}

        {/* 图标 */}
        {Icon && <Icon className="w-4 h-4 flex-shrink-0" />}

        {/* 标签 */}
        <span className="flex-1">{item.label}</span>

        {/* 快捷键 */}
        {item.shortcut && <span className="text-xs text-text-muted ml-4">{item.shortcut}</span>}

        {/* 子菜单箭头 */}
        {hasChildren && <ChevronRight className="w-4 h-4 text-text-muted" />}
      </button>

      {hasChildren && !item.disabled && (
        <div
          role="menu"
          className={clsx(
            expanded
              ? 'block'
              : 'hidden group-hover/menu-item:block group-focus-within/menu-item:block',
            'absolute top-0 min-w-[180px] max-w-[280px]',
            'bg-bg-secondary border border-border rounded-lg shadow-lg',
            'py-1 px-1',
            // 负边距盖住父菜单的 px-1 间隙，否则移向子菜单时会离开 group hover 并收起
            submenuDirection === 'left' ? 'right-full -mr-px' : 'left-full -ml-px',
            depth > 0 && 'z-[10000]',
          )}
        >
          {item.children!.map((child, index) => (
            <MenuItemComponent
              key={child.divider ? `divider-${index}` : child.id}
              item={child}
              onClose={onClose}
              submenuDirection={submenuDirection}
              isMobile={false}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// 右键菜单组件
export function ContextMenu({ items, position, onClose }: ContextMenuProps) {
  const isMobile = useIsMobile();
  const menuRef = useRef<HTMLDivElement>(null);
  const [submenuDirection, setSubmenuDirection] = useState<'left' | 'right'>('right');

  // 点击外部关闭菜单
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    // 延迟添加事件监听，避免触发右键菜单的点击被立即捕获
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleEscape);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  // 调整菜单位置，确保不超出视口（仅桌面端需要）
  useEffect(() => {
    if (isMobile || !menuRef.current) return;

    const menu = menuRef.current;
    const rect = menu.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let { x, y } = position;

    // 确保菜单不超出右边界
    if (x + rect.width > viewportWidth) {
      x = viewportWidth - rect.width - 8;
    }

    // 确保菜单不超出下边界
    if (y + rect.height > viewportHeight) {
      y = viewportHeight - rect.height - 8;
    }

    // 确保不小于 0
    x = Math.max(8, x);
    y = Math.max(8, y);
    setSubmenuDirection(x + rect.width + 188 > viewportWidth ? 'left' : 'right');

    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
  }, [position, isMobile]);

  if (isMobile) {
    return createPortal(
      <div
        className="fixed inset-0 z-[10060] bg-black/50 backdrop-blur-xs flex flex-col justify-end animate-in fade-in duration-150"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div
          ref={menuRef}
          className="mxu-overlay-surface w-full max-h-[82dvh] bg-bg-secondary rounded-t-2xl border-t border-border shadow-2xl flex flex-col overflow-hidden pb-[env(safe-area-inset-bottom)]"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex justify-center pt-2 pb-1 shrink-0">
            <div className="w-10 h-1 rounded-full bg-border-strong/60" />
          </div>
          <div className="overflow-y-auto px-2 py-2 space-y-0.5">
            {items.map((item, index) => (
              <MenuItemComponent
                key={item.divider ? `divider-${index}` : item.id}
                item={item}
                onClose={onClose}
                submenuDirection={submenuDirection}
                isMobile={true}
              />
            ))}
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div
      ref={menuRef}
      className={clsx(
        'fixed z-[9999] min-w-[180px] max-w-[280px]',
        'bg-bg-secondary border border-border rounded-lg shadow-lg',
        'py-1 px-1',
        'animate-in fade-in zoom-in-95 duration-100',
      )}
      style={{ left: position.x, top: position.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, index) => (
        <MenuItemComponent
          key={item.divider ? `divider-${index}` : item.id}
          item={item}
          onClose={onClose}
          submenuDirection={submenuDirection}
          isMobile={false}
        />
      ))}
    </div>,
    document.body,
  );
}

// 右键菜单 Hook
export function useContextMenu() {
  const [state, setState] = useContextMenuState();

  const showAt = useCallback(
    (position: MenuPosition, items: MenuItem[]) => {
      setState({
        isOpen: true,
        position,
        items,
      });
    },
    [setState],
  );

  const show = useCallback(
    (e: React.MouseEvent, items: MenuItem[]) => {
      e.preventDefault();
      e.stopPropagation();
      showAt({ x: e.clientX, y: e.clientY }, items);
    },
    [showAt],
  );

  const hide = useCallback(() => {
    setState((prev) => ({ ...prev, isOpen: false }));
  }, [setState]);

  return { state, show, showAt, hide };
}

// 使用 React state 管理菜单状态
function useContextMenuState(): [
  ContextMenuState,
  React.Dispatch<React.SetStateAction<ContextMenuState>>,
] {
  const [state, setState] = useState<ContextMenuState>({
    isOpen: false,
    position: { x: 0, y: 0 },
    items: [],
  });

  return [state, setState];
}
