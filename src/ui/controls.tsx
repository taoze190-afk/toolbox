import { useState } from 'react';
import type { ControlsProps } from '../tools/types';

export function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="py-3 border-b border-line last:border-0">
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <span className="text-[13px] font-medium text-ink shrink-0">{label}</span>
        {hint && <span className="text-[11px] text-mute text-right min-w-0">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

export function Segmented<T extends string | number>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          onClick={() => onChange(o.value)}
          className={
            'px-3 py-1.5 rounded-lg text-[13px] transition-colors ' +
            (o.value === value ? 'bg-accent text-white' : 'bg-soft text-ink hover:bg-soft2')
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Slider({
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix = '',
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 accent-[var(--color-accent)]"
      />
      <span className="text-[13px] tabular-nums w-16 text-right text-ink">
        {value}
        {suffix}
      </span>
    </div>
  );
}

/**
 * 数字输入。用草稿态存正在敲的文本：直接把 e.target.value 转成数字回写，
 * 会让 "0100" 这种输入被 Number 吃掉前导零后与 React 上一次的渲染值相等，
 * React 认为没变化就不更新 DOM，框里一直显示 0100 而实际值是 100。
 */
export function Num({
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
  const shown = draft ?? (Number.isFinite(value) ? String(value) : '');
  return (
    <div className="flex items-center gap-2">
      <input
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={shown}
        onFocus={() => setDraft(shown)}
        onChange={(e) => {
          const t = e.target.value.replace(/[^0-9.]/g, '');
          setDraft(t);
          const n = Number(t);
          if (t !== '' && t !== '.' && Number.isFinite(n)) onChange(clamp(n));
        }}
        onBlur={() => {
          const n = Number(shown);
          setDraft(null);
          onChange(clamp(shown === '' || !Number.isFinite(n) ? 0 : n));
        }}
        step={step}
        className="w-24 px-2.5 py-2 rounded-lg bg-soft text-[13px] tabular-nums outline-none focus:ring-2 ring-accent/40"
      />
      {suffix && <span className="text-[12px] text-mute">{suffix}</span>}
    </div>
  );
}

export function Toggle({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className="flex items-center gap-2 text-[13px] text-ink"
    >
      <span
        className={
          'w-10 h-6 rounded-full transition-colors relative shrink-0 ' + (value ? 'bg-accent' : 'bg-soft2')
        }
      >
        <span
          className={
            'absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all shadow ' + (value ? 'left-[18px]' : 'left-0.5')
          }
        />
      </span>
      {label && <span>{label}</span>}
    </button>
  );
}

export function Select({
  value,
  onChange,
  groups,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options?: { id: string; name: string }[];
  groups?: { label: string; items: { id: string; name: string; note?: string }[] }[];
}) {
  if (groups) {
    return (
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 rounded-lg bg-soft text-[13px] outline-none"
      >
        {groups.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
                {i.note ? ` · ${i.note}` : ''}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    );
  }
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full px-3 py-2 rounded-lg bg-soft text-[13px] outline-none"
    >
      {options!.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </select>
  );
}

export function Swatches({
  value,
  onChange,
  items,
}: {
  value: string;
  onChange: (v: string) => void;
  items: { id: string; name: string; value: string }[];
}) {
  return (
    <div className="flex gap-2 flex-wrap">
      {items.map((i) => (
        <button
          key={i.id}
          type="button"
          onClick={() => onChange(i.id)}
          className={
            'px-2.5 py-1.5 rounded-lg text-[12px] border transition ' +
            (value === i.id ? 'border-accent ring-2 ring-accent/25' : 'border-line')
          }
        >
          <span className="inline-flex items-center gap-1.5">
            {i.value && <span className="w-3 h-3 rounded-sm border border-black/10" style={{ background: i.value }} />}
            {i.name}
          </span>
        </button>
      ))}
    </div>
  );
}

export function Hint({ children }: { children: React.ReactNode }) {
  return <p className="text-[12px] leading-relaxed text-mute mt-1">{children}</p>;
}

/** 供工具定义快速写参数面板 */
export function Panel({ children }: { children: React.ReactNode }) {
  return <div className="divide-y divide-line">{children}</div>;
}

export type { ControlsProps };
