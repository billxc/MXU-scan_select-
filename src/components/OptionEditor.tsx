import {
  useState,
  useMemo,
  useEffect,
  useLayoutEffect,
  useCallback,
  useRef,
  useId,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import { loadIconAsDataUrl, useResolvedContent } from '@/services/contentResolver';
import type { OptionValue, CaseItem, InputItem, OptionDefinition } from '@/types/interface';
import { findMxuOptionByKey } from '@/types/specialTasks';
import clsx from 'clsx';
import {
  Info,
  AlertCircle,
  Loader2,
  FileText,
  Link,
  ChevronDown,
  Check,
  ChevronRight,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { getInterfaceLangKey } from '@/i18n';
import { findSwitchCase } from '@/utils/optionHelpers';
import { getCheckboxMaxCount, getCheckboxMinCount } from '@/utils/checkboxOptionValidation';
import { stripInlineRichText } from '@/utils/richText';
import { SwitchButton, TextInput, FileInput, TimeInput, HotkeyInput } from './FormControls';
import { RichLabel } from './RichLabel';
import { Tooltip } from './ui/Tooltip';
import { DescriptionHtml } from './ui/DescriptionHtml';
import { rescanScanSelectOption } from '@/services/interfaceLoader';
import { loggers } from '@/utils/logger';
import { useIsMobile } from '@/hooks/useIsMobile';
import { MobileSheet } from './ui/MobileSheet';

/** 判断 switch 类型的选项是否有子选项 */
export function switchHasNestedOptions(optionDef: OptionDefinition): boolean {
  if (optionDef.type !== 'switch') return false;
  // SwitchOption 的 cases 是 [CaseItem, CaseItem]，始终有两个元素
  return optionDef.cases.some((c: CaseItem) => c.option && c.option.length > 0);
}

/** 子选项折叠箭头：复用任务标题的 ChevronRight 样式，位于开关/下拉框左侧 */
function OptionCollapseArrow({
  collapsed,
  onToggle,
  disabled = false,
}: {
  collapsed: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={(e) => {
        // 所在行整体点击会切换开关/下拉框，必须阻止冒泡
        e.stopPropagation();
        onToggle();
      }}
      disabled={disabled}
      aria-expanded={!collapsed}
      aria-label={collapsed ? t('optionEditor.expandOptions') : t('optionEditor.collapseOptions')}
      title={collapsed ? t('optionEditor.expandOptions') : t('optionEditor.collapseOptions')}
      // ml-auto：吸收行内剩余空白（label 受 max-w-[60%] 限制无法全部吸收），
      // 让箭头紧贴开关/下拉框，空隙只留在箭头左侧
      className="p-1 rounded hover:bg-bg-hover flex-shrink-0 ml-auto disabled:cursor-not-allowed disabled:opacity-50"
    >
      <ChevronRight
        className={clsx(
          'w-4 h-4 text-text-secondary transition-transform duration-150 ease-out',
          !collapsed && 'rotate-90',
        )}
      />
    </button>
  );
}

/** 异步加载图标组件 */
function AsyncIcon({
  icon,
  basePath,
  className,
}: {
  icon?: string;
  basePath: string;
  className?: string;
}) {
  const [iconUrl, setIconUrl] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!icon) {
      setIconUrl(undefined);
      return;
    }
    loadIconAsDataUrl(icon, basePath).then(setIconUrl);
  }, [icon, basePath]);

  if (!iconUrl) return null;
  return <img src={iconUrl} alt="" className={className} />;
}

interface OptionEditorProps {
  /** 全局作用域下可省略（值读写 store.globalOptionValues） */
  instanceId?: string;
  taskId?: string;
  optionKey: string;
  value?: OptionValue;
  /** 嵌套层级，用于缩进显示 */
  depth?: number;
  /** 是否禁用编辑（只读模式） */
  disabled?: boolean;
  /** 全局作用域：值读写 store.globalOptionValues，用于设置页全局设置编辑 */
  globalScope?: boolean;
  /** 是否继承父级不兼容状态 */
  controllerIncompatible?: boolean;
  /** 父级不兼容原因（用于嵌套提示文案） */
  parentIncompatibilityReason?: IncompatibilityReason;
}

type IncompatibilityReason = 'controller' | 'resource';

/** 显示带图标的标签（仅标签本身） */
function OptionLabel({
  label,
  icon,
  basePath,
}: {
  label: string;
  icon?: string;
  basePath: string;
}) {
  return (
    <div className="flex items-center gap-1.5 min-w-[80px]">
      {icon && (
        <AsyncIcon
          icon={icon}
          basePath={basePath}
          className="w-4 h-4 object-contain flex-shrink-0"
        />
      )}
      <RichLabel text={label} className="text-sm text-text-secondary" />
    </div>
  );
}

/** 显示带图标的标签 + 控制器不兼容警告提示 */
function OptionLabelWithIncompatible({
  label,
  icon,
  basePath,
  incompatibleReason,
}: {
  label: string;
  icon?: string;
  basePath: string;
  incompatibleReason?: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <OptionLabel label={label} icon={icon} basePath={basePath} />
      {incompatibleReason && (
        <Tooltip content={incompatibleReason}>
          <AlertCircle className="w-3.5 h-3.5 text-warning flex-shrink-0" />
        </Tooltip>
      )}
    </div>
  );
}

function isOptionControllerIncompatible(
  optionDef: OptionDefinition | null | undefined,
  controllerName: string | undefined,
): boolean {
  if (!optionDef?.controller || optionDef.controller.length === 0) return false;
  if (!controllerName) return false;
  return !optionDef.controller.includes(controllerName);
}

function isOptionResourceIncompatible(
  optionDef: OptionDefinition | null | undefined,
  resourceName: string | undefined,
): boolean {
  if (!optionDef?.resource || optionDef.resource.length === 0) return false;
  if (!resourceName) return false;
  return !optionDef.resource.includes(resourceName);
}

/** 显示选项描述文本（支持文件/URL/直接文本，以及 Markdown/HTML 和本地图片） */
function OptionDescription({
  description,
  basePath,
  translations,
}: {
  description?: string;
  basePath: string;
  translations?: Record<string, string>;
}) {
  const { t } = useTranslation();
  const resolved = useResolvedContent(description, basePath, translations);

  if (!description && !resolved.loading) return null;

  if (resolved.loading) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-text-muted">
        <Loader2 className="w-3 h-3 animate-spin" />
        <span>{t('optionEditor.loadingDescription')}</span>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {/* 来源提示 */}
      {resolved.loaded && resolved.type !== 'text' && (
        <div className="flex items-center gap-1 text-[10px] text-text-muted">
          {resolved.type === 'file' ? (
            <FileText className="w-3 h-3" />
          ) : (
            <Link className="w-3 h-3" />
          )}
          <span>
            {t(
              resolved.type === 'file'
                ? 'optionEditor.loadedFromFile'
                : 'optionEditor.loadedFromUrl',
            )}
          </span>
        </div>
      )}
      {/* 加载错误提示 */}
      {resolved.error && resolved.type !== 'text' && (
        <div className="flex items-center gap-1 text-[10px] text-warning">
          <AlertCircle className="w-3 h-3" />
          <span>
            {t('optionEditor.loadDescriptionFailed')}: {resolved.error}
          </span>
        </div>
      )}
      {/* 内容 */}
      {resolved.html && (
        <DescriptionHtml
          className="text-xs text-text-secondary [&_p]:my-0.5 [&_a]:text-accent [&_a]:hover:underline"
          html={resolved.html}
          allowLocalLinks={!resolved.loading && resolved.type !== 'url'}
        />
      )}
    </div>
  );
}

/** 输入字段组件，支持验证 */
function InputField({
  input,
  value,
  onChange,
  langKey,
  resolveI18nText,
  basePath,
  disabled,
  isMxuOption = false,
  isHotkey = false,
  t,
}: {
  input: InputItem;
  value: string;
  onChange: (val: string) => void;
  langKey: string;
  resolveI18nText: (text: string | undefined, lang: string) => string;
  basePath: string;
  disabled?: boolean;
  isMxuOption?: boolean;
  isHotkey?: boolean;
  t?: (key: string) => string;
}) {
  // 对于 MXU 内置选项，使用 t() 翻译
  const inputLabel =
    isMxuOption && t
      ? t(input.label || input.name)
      : resolveI18nText(input.label, langKey) || input.name;
  const inputDescription =
    isMxuOption && t
      ? input.description
        ? t(input.description)
        : undefined
      : resolveI18nText(input.description, langKey);
  const patternMsg =
    isMxuOption && t
      ? input.pattern_msg
        ? t(input.pattern_msg)
        : undefined
      : resolveI18nText(input.pattern_msg, langKey);
  const inputPlaceholder =
    isMxuOption && t
      ? input.placeholder
        ? t(input.placeholder)
        : input.default || undefined
      : resolveI18nText(input.placeholder, langKey) || input.default || undefined;

  // 验证输入
  const validationError = useMemo(() => {
    if (!input.verify || !value) return null;
    try {
      const regex = new RegExp(input.verify);
      if (!regex.test(value)) {
        return patternMsg || `输入不符合格式要求`;
      }
    } catch {
      // 正则无效，跳过验证
    }
    return null;
  }, [input.verify, value, patternMsg]);

  return (
    <div className="space-y-1">
      <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-1.5 sm:gap-3 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0 sm:flex-1 sm:basis-[14rem]">
          {input.icon && (
            <AsyncIcon
              icon={input.icon}
              basePath={basePath}
              className="w-4 h-4 object-contain flex-shrink-0"
            />
          )}
          <RichLabel text={inputLabel} className="text-sm text-text-tertiary truncate" />
          {inputDescription && (
            <Tooltip content={inputDescription} side="top" align="start" maxWidth="max-w-[200px]">
              <Info className="w-3.5 h-3.5 text-text-muted cursor-help flex-shrink-0" />
            </Tooltip>
          )}
        </div>
        {isHotkey ? (
          <HotkeyInput
            value={value}
            onChange={onChange}
            placeholder={inputPlaceholder}
            disabled={disabled}
            className="w-full sm:min-w-[min(12rem,100%)] sm:flex-1 sm:basis-[30%] py-2.5 sm:py-1.5 text-base sm:text-sm"
          />
        ) : input.input_type === 'file' ? (
          <FileInput
            value={value}
            onChange={onChange}
            placeholder={inputPlaceholder}
            basePath={basePath}
            defaultDirectory={input.file_dialog_dir}
            filters={input.file_dialog_filters?.map((filter) => ({
              ...filter,
              name: resolveI18nText(filter.name, langKey) || filter.name,
            }))}
            disabled={disabled}
            className="w-full sm:min-w-[min(12rem,100%)] sm:flex-1 sm:basis-[30%]"
          />
        ) : input.input_type === 'time' ? (
          <TimeInput
            value={value}
            onChange={onChange}
            disabled={disabled}
            className="w-full sm:min-w-[min(12rem,100%)] sm:flex-1 sm:basis-[30%] py-2.5 sm:py-1.5 text-base sm:text-sm"
          />
        ) : (
          <TextInput
            value={value}
            onChange={onChange}
            placeholder={inputPlaceholder}
            disabled={disabled}
            hasError={!!validationError}
            className="w-full sm:min-w-[min(12rem,100%)] sm:flex-1 sm:basis-[30%] py-2.5 sm:py-1.5 text-base sm:text-sm"
            type={input.password ? 'password' : input.pipeline_type === 'int' ? 'number' : 'text'}
            inputMode={input.pipeline_type === 'int' ? 'numeric' : undefined}
            step={input.pipeline_type === 'int' ? 1 : undefined}
            integerOnly={input.pipeline_type === 'int'}
          />
        )}
      </div>
      {validationError && (
        <div className="flex items-center gap-1 text-xs text-error justify-end">
          <AlertCircle className="w-3 h-3" />
          <span>{validationError}</span>
        </div>
      )}
    </div>
  );
}

export function OptionEditor({
  instanceId = '',
  taskId = '',
  optionKey,
  value,
  depth = 0,
  disabled = false,
  globalScope = false,
  controllerIncompatible = false,
  parentIncompatibilityReason,
}: OptionEditorProps) {
  const { t } = useTranslation();
  const {
    projectInterface,
    setTaskOptionValue,
    globalOptionValues,
    setGlobalOptionValue,
    resolveI18nText,
    language,
    basePath,
    interfaceTranslations,
    instances,
  } = useAppStore();

  // 支持 MXU 内置选项定义（检查 optionKey 是否以 __MXU_ 开头）
  const isMxuOption = optionKey.startsWith('__MXU_');
  // 通过 optionKey 从所有注册的特殊任务中反查选项定义
  const mxuOptionDef = isMxuOption ? findMxuOptionByKey(optionKey) : null;
  const optionDef = isMxuOption ? mxuOptionDef : projectInterface?.option?.[optionKey];

  // 获取当前任务的所有选项值（用于嵌套选项）；全局作用域下取 globalOptionValues
  const allOptionValues = useMemo(() => {
    if (globalScope) return globalOptionValues;
    const instance = instances.find((i) => i.id === instanceId);
    const task = instance?.selectedTasks.find((t) => t.id === taskId);
    return task?.optionValues || {};
  }, [globalScope, globalOptionValues, instances, instanceId, taskId]);
  const instance = useMemo(
    () => instances.find((item) => item.id === instanceId),
    [instances, instanceId],
  );
  // 子选项折叠状态：任务作用域存 store（随配置持久化）；全局作用域用本地 state 兜底
  const collapsedOptions = useMemo(() => {
    if (globalScope) return undefined;
    const instance = instances.find((i) => i.id === instanceId);
    const task = instance?.selectedTasks.find((t) => t.id === taskId);
    return task?.collapsedOptions;
  }, [globalScope, instances, instanceId, taskId]);
  const [localCollapsed, setLocalCollapsed] = useState(false);

  if (!optionDef) return null;

  // 全局作用域下顶层值取自 globalOptionValues；否则用传入的 value
  const effectiveValue = globalScope ? (value ?? globalOptionValues[optionKey]) : value;
  // 统一提交入口：全局作用域写 globalOptionValues，否则写任务实例
  const commitOptionValue = (next: OptionValue) => {
    if (globalScope) {
      setGlobalOptionValue(optionKey, next);
    } else {
      setTaskOptionValue(instanceId, taskId, optionKey, next);
    }
  };

  const langKey = getInterfaceLangKey(language);
  // 对于 MXU 内置选项，使用 t() 翻译
  const optionLabel = isMxuOption
    ? t(optionDef.label || optionKey)
    : resolveI18nText(optionDef.label, langKey) || optionKey;
  const optionDescription = isMxuOption
    ? optionDef.description
      ? t(optionDef.description)
      : undefined
    : resolveI18nText(optionDef.description, langKey);
  const translations = interfaceTranslations[langKey];
  const currentControllerName = instance?.controllerName || projectInterface?.controller[0]?.name;
  const currentResourceName = instance?.resourceName || projectInterface?.resource[0]?.name;
  const selfControllerIncompatible = isOptionControllerIncompatible(
    optionDef,
    currentControllerName,
  );
  const selfResourceIncompatible = isOptionResourceIncompatible(optionDef, currentResourceName);
  const isOptionIncompatible =
    controllerIncompatible || selfControllerIncompatible || selfResourceIncompatible;
  const incompatibleReasonType: IncompatibilityReason | undefined = selfControllerIncompatible
    ? 'controller'
    : selfResourceIncompatible
      ? 'resource'
      : controllerIncompatible
        ? parentIncompatibilityReason
        : undefined;
  const incompatibleReason =
    incompatibleReasonType === 'controller'
      ? t('optionEditor.incompatibleController')
      : incompatibleReasonType === 'resource'
        ? t('optionEditor.incompatibleResource')
        : undefined;
  const effectiveDisabled = disabled || isOptionIncompatible;

  // 获取当前选中的 case（用于渲染嵌套选项）
  const getSelectedCase = (): CaseItem | undefined => {
    if (optionDef.type === 'switch') {
      const isChecked = effectiveValue?.type === 'switch' ? effectiveValue.value : false;
      return findSwitchCase(optionDef.cases, isChecked);
    }
    if (optionDef.type === 'select' || optionDef.type === 'scan_select' || !optionDef.type) {
      const caseName =
        effectiveValue?.type === 'select'
          ? effectiveValue.caseName
          : optionDef.default_case || optionDef.cases?.[0]?.name;
      return optionDef.cases?.find((c) => c.name === caseName);
    }
    return undefined;
  };

  const selectedCase = getSelectedCase();
  const nestedOptionKeys = selectedCase?.option || [];

  // 当前选项的子选项是否处于折叠状态（缺省展开）
  const isCollapsed = globalScope ? localCollapsed : !!collapsedOptions?.[optionKey];
  const handleToggleCollapsed = () => {
    if (effectiveDisabled) return;
    if (globalScope) {
      setLocalCollapsed((prev) => !prev);
    } else {
      useAppStore.getState().toggleOptionCollapsed(instanceId, taskId, optionKey);
    }
  };

  // Switch 类型
  if (optionDef.type === 'switch') {
    const isChecked = effectiveValue?.type === 'switch' ? effectiveValue.value : false;
    const handleToggleSwitch = () => {
      if (effectiveDisabled) return;
      commitOptionValue({
        type: 'switch',
        value: !isChecked,
      });
    };
    const handleSwitchRowKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) return;
      if (event.repeat) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      handleToggleSwitch();
    };

    return (
      <div
        className={clsx(
          'space-y-3',
          depth > 0 && 'ml-2 pl-2.5 sm:ml-4 sm:pl-3 border-l-2 border-border',
        )}
      >
        <div
          className={clsx(
            'flex items-center justify-between gap-3 rounded-md px-2 py-2.5 sm:py-1.5 -mx-2 transition-colors',
            !effectiveDisabled && 'cursor-pointer hover:bg-bg-hover',
            effectiveDisabled && 'cursor-not-allowed',
            isOptionIncompatible && 'opacity-60',
          )}
          onClick={(e) => {
            if ((e.target as HTMLElement).closest('a')) return;
            handleToggleSwitch();
          }}
          onKeyDown={handleSwitchRowKeyDown}
          role="switch"
          tabIndex={effectiveDisabled ? -1 : 0}
          aria-checked={isChecked}
          aria-disabled={effectiveDisabled}
        >
          <div className="min-w-0 flex-1 max-w-[78%] sm:max-w-[60%]">
            <OptionLabelWithIncompatible
              label={optionLabel}
              icon={optionDef.icon}
              basePath={basePath}
              incompatibleReason={incompatibleReason}
            />
            <OptionDescription
              description={optionDescription}
              basePath={basePath}
              translations={translations}
            />
          </div>
          {nestedOptionKeys.length > 0 && (
            <OptionCollapseArrow
              collapsed={isCollapsed}
              onToggle={handleToggleCollapsed}
              disabled={effectiveDisabled}
            />
          )}
          <div className="pointer-events-none flex-shrink-0" aria-hidden="true">
            <SwitchButton
              value={isChecked}
              onChange={handleToggleSwitch}
              disabled={effectiveDisabled}
              tabIndex={-1}
            />
          </div>
        </div>
        {/* 渲染嵌套选项（可折叠，复用任务标题的 grid 展开动画） */}
        {nestedOptionKeys.length > 0 && (
          <div
            className="grid transition-[grid-template-rows] duration-150 ease-out"
            style={{ gridTemplateRows: isCollapsed ? '0fr' : '1fr' }}
          >
            <div className={clsx('min-h-0', isCollapsed ? 'overflow-hidden' : 'overflow-visible')}>
              <div className="space-y-3">
                {nestedOptionKeys.map((nestedKey) => (
                  <OptionEditor
                    key={nestedKey}
                    instanceId={instanceId}
                    taskId={taskId}
                    optionKey={nestedKey}
                    value={allOptionValues[nestedKey]}
                    depth={depth + 1}
                    disabled={effectiveDisabled}
                    globalScope={globalScope}
                    controllerIncompatible={isOptionIncompatible}
                    parentIncompatibilityReason={incompatibleReasonType}
                  />
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Checkbox 类型 (多选)
  if (optionDef.type === 'checkbox') {
    const selectedCases =
      effectiveValue?.type === 'checkbox' ? effectiveValue.caseNames : optionDef.default_case || [];
    const selectedCount = new Set(selectedCases).size;
    const minCount = getCheckboxMinCount(optionDef);
    const maxCount = getCheckboxMaxCount(optionDef);
    const isBelowMinimum = selectedCount < minCount;
    const isAtMaximum = maxCount !== undefined && selectedCount >= maxCount;
    const countConstraint =
      minCount > 0 && maxCount !== undefined
        ? t('optionEditor.checkboxCountRange', { min: minCount, max: maxCount })
        : minCount > 0
          ? t('optionEditor.checkboxCountMinimum', { min: minCount })
          : maxCount !== undefined
            ? t('optionEditor.checkboxCountMaximum', { max: maxCount })
            : null;

    return (
      <div
        className={clsx(
          'space-y-3',
          depth > 0 && 'ml-2 pl-2.5 sm:ml-4 sm:pl-3 border-l-2 border-border',
          isOptionIncompatible && 'opacity-60',
        )}
      >
        <OptionLabelWithIncompatible
          label={optionLabel}
          icon={optionDef.icon}
          basePath={basePath}
          incompatibleReason={incompatibleReason}
        />
        <OptionDescription
          description={optionDescription}
          basePath={basePath}
          translations={translations}
        />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-1">
          {optionDef.cases.map((caseItem) => {
            const caseLabel = isMxuOption
              ? t(caseItem.label || caseItem.name)
              : resolveI18nText(caseItem.label, langKey) || caseItem.name;
            const isChecked = selectedCases.includes(caseItem.name);
            const isCaseDisabled = effectiveDisabled || (!isChecked && isAtMaximum);
            return (
              <button
                key={caseItem.name}
                type="button"
                onClick={() => {
                  if (isCaseDisabled) return;
                  const newCases = isChecked
                    ? selectedCases.filter((n) => n !== caseItem.name)
                    : [...selectedCases, caseItem.name];
                  commitOptionValue({
                    type: 'checkbox',
                    caseNames: newCases,
                  });
                }}
                disabled={isCaseDisabled}
                className={clsx(
                  'px-3 py-2.5 text-sm sm:px-2 sm:py-1.5 sm:text-xs rounded border transition-colors min-w-0',
                  isChecked
                    ? 'bg-accent text-white border-accent'
                    : 'bg-bg-primary text-text-secondary border-border hover:border-accent hover:text-accent',
                  isCaseDisabled && 'opacity-60 cursor-not-allowed',
                )}
                title={
                  !isChecked && isAtMaximum
                    ? `${caseLabel} — ${t('optionEditor.checkboxMaximumReached', { max: maxCount })}`
                    : caseLabel
                }
                aria-pressed={isChecked}
              >
                <span className="flex items-center gap-1.5 min-w-0">
                  {caseItem.icon && (
                    <AsyncIcon
                      icon={caseItem.icon}
                      basePath={basePath}
                      className="w-4 h-4 object-contain flex-shrink-0"
                    />
                  )}
                  <RichLabel text={caseLabel} className="truncate" />
                </span>
              </button>
            );
          })}
        </div>
        {countConstraint && (
          <div
            className={clsx(
              'flex items-center gap-1 text-xs',
              isBelowMinimum ? 'text-error' : 'text-text-muted',
            )}
          >
            {isBelowMinimum && <AlertCircle className="w-3 h-3 flex-shrink-0" />}
            <span>
              {isBelowMinimum
                ? t('optionEditor.checkboxMinimumRequired', {
                    min: minCount,
                    count: selectedCount,
                  })
                : t('optionEditor.checkboxSelectedCount', {
                    count: selectedCount,
                    constraint: countConstraint,
                  })}
            </span>
          </div>
        )}
      </div>
    );
  }

  // Input / Hotkey 类型
  if (optionDef.type === 'input' || optionDef.type === 'hotkey') {
    const fields = optionDef.type === 'input' ? optionDef.inputs : optionDef.hotkeys;
    const inputValues =
      effectiveValue?.type === 'input' || effectiveValue?.type === 'hotkey'
        ? effectiveValue.values
        : {};

    return (
      <div
        className={clsx(
          'space-y-3',
          depth > 0 && 'ml-2 pl-2.5 sm:ml-4 sm:pl-3 border-l-2 border-border',
          isOptionIncompatible && 'opacity-60',
        )}
      >
        <div className="w-full sm:max-w-[60%]">
          <OptionLabelWithIncompatible
            label={optionLabel}
            icon={optionDef.icon}
            basePath={basePath}
            incompatibleReason={incompatibleReason}
          />
          <OptionDescription
            description={optionDescription}
            basePath={basePath}
            translations={translations}
          />
        </div>
        {fields.map((input) => {
          const inputValue = inputValues[input.name] ?? input.default ?? '';
          const isHotkey = optionDef.type === 'hotkey';

          return (
            <InputField
              key={input.name}
              input={input}
              value={inputValue}
              isHotkey={isHotkey}
              onChange={(newVal) => {
                if (effectiveDisabled) return;
                commitOptionValue({
                  type: isHotkey ? 'hotkey' : 'input',
                  values: { ...inputValues, [input.name]: newVal },
                });
              }}
              langKey={langKey}
              resolveI18nText={resolveI18nText}
              basePath={basePath}
              disabled={effectiveDisabled}
              isMxuOption={isMxuOption}
              t={t}
            />
          );
        })}
      </div>
    );
  }

  // Select / scan_select 类型 (默认)
  const selectedCaseName =
    effectiveValue?.type === 'select'
      ? effectiveValue.caseName
      : optionDef.default_case || optionDef.cases[0]?.name;

  // 选项超过 4 个时使用 ComboBox（带搜索功能）
  const useComboBox = optionDef.cases.length > 4;
  const SelectComponent = useComboBox ? OptionSelectComboBox : OptionSelectDropdown;

  // scan_select 类型需要刷新按钮
  const isScanSelect = optionDef.type === 'scan_select';
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = async () => {
    if (isRefreshing || !projectInterface) return;
    setIsRefreshing(true);
    try {
      const newCases = await rescanScanSelectOption(projectInterface, basePath, optionKey);
      // 通过 Zustand 不可变更新触发重渲染
      useAppStore.getState().updateScanSelectCases(optionKey, newCases);
    } catch (error) {
      loggers.app.error('scan_select 重扫失败:', error);
    } finally {
      setIsRefreshing(false);
    }
  };

  return (
    <div
      className={clsx(
        'space-y-3',
        depth > 0 && 'ml-2 pl-2.5 sm:ml-4 sm:pl-3 border-l-2 border-border',
        isOptionIncompatible && 'opacity-60',
      )}
    >
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
        <div className="flex items-start justify-between gap-2 min-w-0 w-full sm:flex-1 sm:max-w-[60%]">
          <div className="min-w-0 flex-1">
            <OptionLabelWithIncompatible
              label={optionLabel}
              icon={optionDef.icon}
              basePath={basePath}
              incompatibleReason={incompatibleReason}
            />
            <OptionDescription
              description={optionDescription}
              basePath={basePath}
              translations={translations}
            />
          </div>
          {nestedOptionKeys.length > 0 && (
            <div className="sm:hidden">
              <OptionCollapseArrow
                collapsed={isCollapsed}
                onToggle={handleToggleCollapsed}
                disabled={effectiveDisabled}
              />
            </div>
          )}
        </div>
        {nestedOptionKeys.length > 0 && (
          <div className="hidden sm:flex ml-auto">
            <OptionCollapseArrow
              collapsed={isCollapsed}
              onToggle={handleToggleCollapsed}
              disabled={effectiveDisabled}
            />
          </div>
        )}
        <div
          className={clsx(
            'flex items-center gap-2 w-full sm:w-[30%] sm:flex-shrink-0',
            nestedOptionKeys.length === 0 && 'sm:ml-auto',
          )}
        >
          <SelectComponent
            className="flex-1 min-w-0"
            title={optionLabel}
            value={selectedCaseName}
            disabled={effectiveDisabled}
            basePath={basePath}
            options={optionDef.cases.map((caseItem) => {
              const label = isMxuOption
                ? t(caseItem.label || caseItem.name)
                : resolveI18nText(caseItem.label, langKey) || caseItem.name;
              return {
                value: caseItem.name,
                label,
                icon: caseItem.icon,
              };
            })}
            onChange={(next) => {
              if (effectiveDisabled) return;
              commitOptionValue({
                type: 'select',
                caseName: next,
              });
            }}
          />
          {/* scan_select 类型的刷新按钮 */}
          {isScanSelect && (
            <Tooltip content={t('common.refresh') || '刷新'}>
              <button
                className={clsx(
                  'p-2.5 sm:p-1.5 rounded-md border border-border sm:border-transparent bg-bg-secondary sm:bg-transparent transition-colors shrink-0',
                  'hover:bg-bg-hover',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                  isRefreshing && 'animate-spin',
                )}
                disabled={effectiveDisabled || isRefreshing}
                onClick={handleRefresh}
              >
                <RefreshCw size={16} />
              </button>
            </Tooltip>
          )}
        </div>
      </div>
      {/* scan_select：选项下方显示当前选中项的图片（扫描结果为图片时） */}
      {isScanSelect && selectedCase?.icon && (
        <div className="flex items-center justify-center rounded-md border border-border bg-bg-tertiary p-2">
          <AsyncIcon
            icon={selectedCase.icon}
            basePath={basePath}
            className="h-auto w-auto max-w-full object-contain rounded"
          />
        </div>
      )}
      {/* 渲染嵌套选项（可折叠，复用任务标题的 grid 展开动画） */}
      {nestedOptionKeys.length > 0 && (
        <div
          className="grid transition-[grid-template-rows] duration-150 ease-out"
          style={{ gridTemplateRows: isCollapsed ? '0fr' : '1fr' }}
        >
          <div className={clsx('min-h-0', isCollapsed ? 'overflow-hidden' : 'overflow-visible')}>
            <div className="space-y-3">
              {nestedOptionKeys.map((nestedKey) => (
                <OptionEditor
                  key={nestedKey}
                  instanceId={instanceId}
                  taskId={taskId}
                  optionKey={nestedKey}
                  value={allOptionValues[nestedKey]}
                  depth={depth + 1}
                  disabled={effectiveDisabled}
                  globalScope={globalScope}
                  controllerIncompatible={isOptionIncompatible}
                  parentIncompatibilityReason={incompatibleReasonType}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface DropdownPosition {
  top?: number;
  bottom?: number;
  left: number;
  width: number;
  maxHeight: number;
  placement: 'top' | 'bottom';
}

/** 下拉框浮层定位 Hook：通过 Portal 脱离父级容器 overflow 裁切，支持智能翻转与视口避让 */
function useDropdownPosition({
  open,
  triggerRef,
  menuRef,
  onClose,
  minWidth = 220,
}: {
  open: boolean;
  triggerRef: React.RefObject<HTMLElement | null>;
  menuRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  minWidth?: number;
}) {
  const [position, setPosition] = useState<DropdownPosition | null>(null);

  const updatePosition = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();

    // 如果 trigger 已经离开可视区域（例如在可滚动面板中被滚出屏幕），则自动关闭
    if (rect.bottom < 0 || rect.top > window.innerHeight) {
      onClose();
      return;
    }

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    const targetWidth = Math.min(Math.max(rect.width, minWidth), viewportWidth - 16);

    // 水平对齐：优先右对齐（向左展开），如果左边缘越界则靠左
    let left = rect.right - targetWidth;
    if (left < 8) {
      left = Math.max(8, rect.left);
    }
    if (left + targetWidth > viewportWidth - 8) {
      left = Math.max(8, viewportWidth - targetWidth - 8);
    }

    const offset = 4;
    const margin = 8;
    const spaceBelow = viewportHeight - rect.bottom - offset - margin;
    const spaceAbove = rect.top - offset - margin;

    // 当下方剩余空间不足 200px 且上方空间大于下方空间时向上弹出
    const shouldFlip = spaceBelow < 200 && spaceAbove > spaceBelow;

    if (shouldFlip) {
      const maxHeight = Math.min(260, Math.max(120, spaceAbove));
      setPosition({
        bottom: viewportHeight - rect.top + offset,
        left,
        width: targetWidth,
        maxHeight,
        placement: 'top',
      });
    } else {
      const maxHeight = Math.min(260, Math.max(120, spaceBelow));
      setPosition({
        top: rect.bottom + offset,
        left,
        width: targetWidth,
        maxHeight,
        placement: 'bottom',
      });
    }
  }, [triggerRef, minWidth, onClose]);

  // 打开时使用 useLayoutEffect 立即计算位置，避免闪烁
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    updatePosition();
  }, [open, updatePosition]);

  // 监听 resize、scroll（捕获阶段）以及点击外部
  useEffect(() => {
    if (!open) return;

    const handleScroll = (event: Event) => {
      const target = event.target;
      // 菜单内部滚动不影响展开状态；祖先面板滚动时关闭，避免浮层脱离任务。
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      if (target instanceof Node && triggerRef.current && target.contains(triggerRef.current)) {
        onClose();
      }
    };

    const handleResize = () => {
      updatePosition();
    };

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        triggerRef.current &&
        !triggerRef.current.contains(target) &&
        menuRef.current &&
        !menuRef.current.contains(target)
      ) {
        onClose();
      }
    };

    window.addEventListener('resize', handleResize);
    window.addEventListener('scroll', handleScroll, true);
    document.addEventListener('mousedown', handleClickOutside);

    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('scroll', handleScroll, true);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [open, updatePosition, triggerRef, menuRef, onClose]);

  return position;
}

interface OptionSelectDropdownProps {
  value: string;
  options: { value: string; label: string; icon?: string }[];
  disabled?: boolean;
  className?: string;
  title?: string;
  basePath: string;
  onChange: (value: string) => void;
}

/** 移动端原生级 Bottom Sheet 选择器（支持普通单选与可搜索单选，不受视口滚动与软键盘影响） */
function MobileSelectSheet({
  open,
  title,
  value,
  options,
  searchable = false,
  basePath,
  onSelect,
  onClose,
}: {
  open: boolean;
  title?: string;
  value: string;
  options: { value: string; label: string; icon?: string }[];
  searchable?: boolean;
  basePath: string;
  onSelect: (value: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    if (open) {
      setSearchQuery('');
    }
  }, [open]);

  const filteredOptions = useMemo(() => {
    if (!searchable || !searchQuery.trim()) return options;
    const query = searchQuery.toLowerCase();
    return options.filter(
      (opt) =>
        stripInlineRichText(opt.label).toLowerCase().includes(query) ||
        opt.value.toLowerCase().includes(query),
    );
  }, [options, searchQuery, searchable]);

  if (!open) return null;

  return (
    <MobileSheet
      open={open}
      onClose={onClose}
      title={title ? stripInlineRichText(title) : t('common.edit')}
      maxHeightClassName="max-h-[82dvh]"
      zIndexClassName="z-[10050]"
    >
      {/* 搜索框（大于 4 项时启用，字号 text-base 避免 iOS 缩放，且不自动强弹软键盘避免遮挡） */}
      {(searchable || options.length > 6) && (
        <div className="px-4 py-2.5 shrink-0 border-b border-border">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('optionEditor.searchPlaceholder')}
              className="w-full pl-9 pr-8 py-2.5 text-base rounded-xl border border-border bg-bg-tertiary text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-text-primary"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* 选项列表 */}
      <div className="overflow-y-auto flex-1 min-h-0 divide-y divide-border/40 px-2 py-1">
        {filteredOptions.length === 0 ? (
          <div className="py-8 text-sm text-text-muted text-center">
            {t('optionEditor.noMatchingOptions')}
          </div>
        ) : (
          filteredOptions.map((opt) => {
            const isSelected = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => {
                  onSelect(opt.value);
                  onClose();
                }}
                className={clsx(
                  'w-full px-3.5 py-3 text-left text-base rounded-xl flex items-center justify-between gap-3 transition-colors',
                  isSelected
                    ? 'bg-accent/12 text-accent font-medium'
                    : 'text-text-primary active:bg-bg-hover',
                )}
              >
                <span className="flex items-center gap-2.5 min-w-0 flex-1">
                  {opt.icon && (
                    <AsyncIcon
                      icon={opt.icon}
                      basePath={basePath}
                      className="w-5 h-5 object-contain flex-shrink-0"
                    />
                  )}
                  <RichLabel text={opt.label} className="break-words" />
                </span>
                {isSelected && <Check className="w-5 h-5 text-accent flex-shrink-0" />}
              </button>
            );
          })
        )}
      </div>
    </MobileSheet>
  );
}

function OptionSelectDropdown({
  value,
  options,
  disabled = false,
  className,
  title,
  basePath,
  onChange,
}: OptionSelectDropdownProps) {
  const isMobile = useIsMobile();
  const triggerId = useId();
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listboxRef = useRef<HTMLDivElement | null>(null);

  const initialIndex = Math.max(
    0,
    options.findIndex((opt) => opt.value === value),
  );
  const [activeIndex, setActiveIndex] = useState(initialIndex);

  const selectedOption = options.find((opt) => opt.value === value) ?? options[0];

  const closeDropdown = useCallback(() => {
    setOpen(false);
  }, []);

  const closeAndFocusTrigger = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  }, []);

  const dropdownPos = useDropdownPosition({
    open: open && !isMobile,
    triggerRef,
    menuRef: listboxRef,
    onClose: closeDropdown,
    minWidth: 220,
  });

  // 打开时初始化活动项并将焦点移动到列表（仅桌面端）
  useEffect(() => {
    if (open && !disabled && !isMobile) {
      const index = Math.max(
        0,
        options.findIndex((opt) => opt.value === value),
      );
      setActiveIndex(index);
      setTimeout(() => {
        listboxRef.current?.focus();
      }, 0);
    }
  }, [open, disabled, isMobile, options, value]);

  // 滚动活动项到视图中
  useEffect(() => {
    if (!open || !listboxRef.current) return;
    const activeElement = listboxRef.current.querySelector(`[data-index="${activeIndex}"]`);
    if (activeElement) {
      activeElement.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex, open]);

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      setOpen((prev) => !prev);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
    } else if (event.key === 'Escape') {
      if (open) {
        event.preventDefault();
        closeAndFocusTrigger();
      }
    }
  };

  const handleListboxKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      // 在默认 Tab 导航前回到原 DOM 位置，兼容 Shift+Tab。
      closeAndFocusTrigger();
      return;
    }
    if (options.length === 0) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((prev) => Math.min(options.length - 1, prev + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((prev) => Math.max(0, prev - 1));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActiveIndex(options.length - 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeAndFocusTrigger();
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const opt = options[activeIndex];
      if (opt) {
        onChange(opt.value);
        closeAndFocusTrigger();
      }
    }
  };

  const isDisabled = disabled || options.length === 0;

  return (
    <div ref={containerRef} className={clsx('relative', className)}>
      <button
        type="button"
        id={triggerId}
        ref={triggerRef}
        disabled={isDisabled}
        className={clsx(
          'w-full px-3 py-2.5 sm:py-1.5 text-sm rounded-md border flex items-center justify-between gap-2',
          'bg-bg-secondary text-text-primary border-border',
          'focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/20',
          isDisabled
            ? 'cursor-not-allowed opacity-60'
            : 'cursor-pointer hover:bg-bg-hover transition-colors',
        )}
        onClick={() => {
          if (isDisabled) return;
          setOpen((prev) => !prev);
        }}
        onKeyDown={handleTriggerKeyDown}
        role="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
      >
        <span className="flex items-center gap-1.5 truncate">
          {selectedOption?.icon && (
            <AsyncIcon
              icon={selectedOption.icon}
              basePath={basePath}
              className="w-4 h-4 object-contain flex-shrink-0"
            />
          )}
          <RichLabel text={selectedOption?.label ?? ''} />
        </span>
        <ChevronDown
          className={clsx('w-4 h-4 text-text-secondary transition-transform', open && 'rotate-180')}
        />
      </button>

      {isMobile ? (
        <MobileSelectSheet
          open={open && !isDisabled}
          title={title}
          value={value}
          options={options}
          searchable={false}
          basePath={basePath}
          onSelect={onChange}
          onClose={closeDropdown}
        />
      ) : (
        open &&
        !isDisabled &&
        dropdownPos &&
        createPortal(
          <div
            id={listboxId}
            ref={listboxRef}
            className="mxu-overlay-surface fixed z-[9999] overflow-y-auto rounded-lg border border-border bg-bg-primary shadow-xl outline-none animate-in fade-in zoom-in-95 duration-100"
            style={{
              top: dropdownPos.top,
              bottom: dropdownPos.bottom,
              left: dropdownPos.left,
              width: dropdownPos.width,
              maxHeight: dropdownPos.maxHeight,
            }}
            role="listbox"
            aria-labelledby={triggerId}
            tabIndex={-1}
            onKeyDown={handleListboxKeyDown}
          >
            {options.map((opt, index) => {
              const isSelected = opt.value === value;
              const isActive = index === activeIndex;
              const optionId = `${listboxId}-option-${opt.value}`;
              return (
                <button
                  key={optionId}
                  id={optionId}
                  type="button"
                  data-index={index}
                  onClick={() => {
                    onChange(opt.value);
                    closeAndFocusTrigger();
                  }}
                  onMouseEnter={() => setActiveIndex(index)}
                  className={clsx(
                    'w-full px-3 py-2 text-left text-sm flex items-center justify-between gap-2',
                    isActive
                      ? 'bg-bg-active text-text-primary'
                      : isSelected
                        ? 'bg-accent/10 text-accent'
                        : 'text-text-primary hover:bg-bg-hover',
                  )}
                  role="option"
                  aria-selected={isSelected}
                  title={stripInlineRichText(opt.label)}
                >
                  <span className="flex items-center gap-1.5 truncate">
                    {opt.icon && (
                      <AsyncIcon
                        icon={opt.icon}
                        basePath={basePath}
                        className="w-4 h-4 object-contain flex-shrink-0"
                      />
                    )}
                    <RichLabel text={opt.label} />
                  </span>
                  {isSelected && <Check className="w-4 h-4 flex-shrink-0" />}
                </button>
              );
            })}
          </div>,
          document.body,
        )
      )}
    </div>
  );
}

/** 带搜索功能的 ComboBox 组件（用于选项数量较多时） */
function OptionSelectComboBox({
  value,
  options,
  disabled = false,
  className,
  title,
  basePath,
  onChange,
}: OptionSelectDropdownProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const triggerId = useId();
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listboxRef = useRef<HTMLDivElement | null>(null);

  const selectedOption = options.find((opt) => opt.value === value) ?? options[0];

  // 过滤选项：label 可能含行内 Markdown（图标等），按去掉标记的纯文本匹配
  const filteredOptions = useMemo(() => {
    if (!searchQuery.trim()) return options;
    const query = searchQuery.toLowerCase();
    return options.filter(
      (opt) =>
        stripInlineRichText(opt.label).toLowerCase().includes(query) ||
        opt.value.toLowerCase().includes(query),
    );
  }, [options, searchQuery]);

  const [activeIndex, setActiveIndex] = useState(0);

  const closeDropdown = useCallback(() => {
    setOpen(false);
    setSearchQuery('');
  }, []);

  const closeAndFocusTrigger = useCallback(() => {
    setOpen(false);
    setSearchQuery('');
    triggerRef.current?.focus({ preventScroll: true });
  }, []);

  const dropdownPos = useDropdownPosition({
    open: open && !isMobile,
    triggerRef,
    menuRef,
    onClose: closeDropdown,
    minWidth: 220,
  });

  const openDropdown = () => {
    setSearchQuery('');
    setActiveIndex(
      Math.max(
        0,
        options.findIndex((opt) => opt.value === value),
      ),
    );
    setOpen(true);
  };

  // 搜索初始化在打开动作中进行（仅桌面端自动聚焦，防止移动端弹软键盘）
  useEffect(() => {
    if (open && !disabled && !isMobile) {
      const timeout = setTimeout(() => {
        inputRef.current?.focus();
      }, 0);
      return () => clearTimeout(timeout);
    }
  }, [open, disabled, isMobile]);

  // 当过滤结果变化时，重置活动索引
  useEffect(() => {
    setActiveIndex(0);
  }, [filteredOptions.length]);

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      if (open) closeDropdown();
      else openDropdown();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!open) openDropdown();
    } else if (event.key === 'Escape') {
      if (open) {
        event.preventDefault();
        closeAndFocusTrigger();
      }
    }
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Tab') {
      closeAndFocusTrigger();
      return;
    }
    if (filteredOptions.length === 0) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeAndFocusTrigger();
      }
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((prev) => Math.min(filteredOptions.length - 1, prev + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((prev) => Math.max(0, prev - 1));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActiveIndex(filteredOptions.length - 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeAndFocusTrigger();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const opt = filteredOptions[activeIndex];
      if (opt) {
        onChange(opt.value);
        closeAndFocusTrigger();
      }
    }
  };

  // 滚动活动项到视图中
  useEffect(() => {
    if (!open || !listboxRef.current) return;
    const activeElement = listboxRef.current.querySelector(`[data-index="${activeIndex}"]`);
    if (activeElement) {
      activeElement.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex, open]);

  const isDisabled = disabled || options.length === 0;

  return (
    <div ref={containerRef} className={clsx('relative', className)}>
      <button
        type="button"
        id={triggerId}
        ref={triggerRef}
        disabled={isDisabled}
        className={clsx(
          'w-full px-3 py-2.5 sm:py-1.5 text-sm rounded-md border flex items-center justify-between gap-2',
          'bg-bg-secondary text-text-primary border-border',
          'focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/20',
          isDisabled
            ? 'cursor-not-allowed opacity-60'
            : 'cursor-pointer hover:bg-bg-hover transition-colors',
        )}
        onClick={() => {
          if (isDisabled) return;
          if (open) closeDropdown();
          else openDropdown();
        }}
        onKeyDown={handleTriggerKeyDown}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
      >
        <span className="flex items-center gap-1.5 truncate">
          {selectedOption?.icon && (
            <AsyncIcon
              icon={selectedOption.icon}
              basePath={basePath}
              className="w-4 h-4 object-contain flex-shrink-0"
            />
          )}
          <RichLabel text={selectedOption?.label ?? ''} />
        </span>
        <ChevronDown
          className={clsx('w-4 h-4 text-text-secondary transition-transform', open && 'rotate-180')}
        />
      </button>

      {isMobile ? (
        <MobileSelectSheet
          open={open && !isDisabled}
          title={title}
          value={value}
          options={options}
          searchable={true}
          basePath={basePath}
          onSelect={onChange}
          onClose={closeDropdown}
        />
      ) : (
        open &&
        !isDisabled &&
        dropdownPos &&
        createPortal(
          <div
            ref={menuRef}
            className="mxu-overlay-surface fixed z-[9999] rounded-lg border border-border bg-bg-primary shadow-xl overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-100"
            style={{
              top: dropdownPos.top,
              bottom: dropdownPos.bottom,
              left: dropdownPos.left,
              width: dropdownPos.width,
              maxHeight: dropdownPos.maxHeight,
            }}
          >
            {/* 搜索输入框 */}
            <div className="p-2 border-b border-border flex-shrink-0">
              <input
                ref={inputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={handleInputKeyDown}
                placeholder={t('optionEditor.searchPlaceholder')}
                className={clsx(
                  'w-full px-2.5 py-1.5 text-sm rounded-md border',
                  'bg-bg-secondary text-text-primary border-border',
                  'focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/20',
                  'placeholder:text-text-muted',
                )}
              />
            </div>

            {/* 选项列表 */}
            <div
              id={listboxId}
              ref={listboxRef}
              className="overflow-y-auto outline-none flex-1 min-h-0"
              role="listbox"
              aria-labelledby={triggerId}
            >
              {filteredOptions.length === 0 ? (
                <div className="px-3 py-2 text-sm text-text-muted text-center">
                  {t('optionEditor.noMatchingOptions')}
                </div>
              ) : (
                filteredOptions.map((opt, index) => {
                  const isSelected = opt.value === value;
                  const isActive = index === activeIndex;
                  const optionId = `${listboxId}-option-${opt.value}`;
                  return (
                    <button
                      key={optionId}
                      id={optionId}
                      type="button"
                      data-index={index}
                      onClick={() => {
                        onChange(opt.value);
                        closeAndFocusTrigger();
                      }}
                      onMouseEnter={() => setActiveIndex(index)}
                      className={clsx(
                        'w-full px-3 py-2 text-left text-sm flex items-center justify-between gap-2',
                        isActive
                          ? 'bg-bg-active text-text-primary'
                          : isSelected
                            ? 'bg-accent/10 text-accent'
                            : 'text-text-primary hover:bg-bg-hover',
                      )}
                      role="option"
                      aria-selected={isSelected}
                      title={stripInlineRichText(opt.label)}
                    >
                      <span className="flex items-center gap-1.5 truncate">
                        {opt.icon && (
                          <AsyncIcon
                            icon={opt.icon}
                            basePath={basePath}
                            className="w-4 h-4 object-contain flex-shrink-0"
                          />
                        )}
                        <RichLabel text={opt.label} />
                      </span>
                      {isSelected && <Check className="w-4 h-4 flex-shrink-0" />}
                    </button>
                  );
                })
              )}
            </div>
          </div>,
          document.body,
        )
      )}
    </div>
  );
}

/** Switch 网格组件的单个项 */
interface SwitchGridItemData {
  optionKey: string;
  /** UI 展示名称，可能含行内 Markdown（图标等）；原生 title 等纯文本场景需先 stripInlineRichText */
  label: string;
  description?: string;
  isChecked: boolean;
  controllerIncompatible?: boolean;
}

interface SwitchGridProps {
  instanceId: string;
  taskId: string;
  items: SwitchGridItemData[];
  disabled?: boolean;
}

/** Switch 网格组件：用于显示多个无子选项的 switch */
export function SwitchGrid({ instanceId, taskId, items, disabled = false }: SwitchGridProps) {
  const { setTaskOptionValue } = useAppStore();
  const { t } = useTranslation();

  const handleToggle = (optionKey: string, currentValue: boolean, itemDisabled: boolean) => {
    if (disabled || itemDisabled) return;
    setTaskOptionValue(instanceId, taskId, optionKey, {
      type: 'switch',
      value: !currentValue,
    });
  };

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-1">
      {items.map((item) => {
        const itemDisabled = disabled || !!item.controllerIncompatible;
        const tooltipContent = item.controllerIncompatible
          ? item.description
            ? `${t('optionEditor.incompatibleController')} — ${item.description}`
            : t('optionEditor.incompatibleController')
          : item.description;
        return (
          <Tooltip key={item.optionKey} content={tooltipContent}>
            <button
              type="button"
              onClick={() => handleToggle(item.optionKey, item.isChecked, itemDisabled)}
              disabled={itemDisabled}
              className={clsx(
                'px-3 py-2.5 text-sm sm:px-2 sm:py-1.5 sm:text-xs rounded border transition-colors truncate',
                item.isChecked
                  ? 'bg-accent text-white border-accent'
                  : 'bg-bg-primary text-text-secondary border-border hover:border-accent hover:text-accent',
                itemDisabled && 'opacity-60 cursor-not-allowed',
              )}
              title={item.description || stripInlineRichText(item.label)}
            >
              <RichLabel text={item.label} />
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}
