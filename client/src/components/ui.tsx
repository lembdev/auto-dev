import type { ComponentProps, HTMLAttributes, ReactNode } from "react";

// Shared look of the controls: every screen takes its buttons, badges, cards and banners from here.

export const cx = (...classes: (string | false | null | undefined)[]): string => classes.filter(Boolean).join(" ");

export type ButtonVariant = "primary" | "secondary" | "danger" | "danger-solid" | "ghost";
export type ButtonSize = "sm" | "md";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-fg hover:bg-accent-hover border border-transparent",
  secondary: "bg-surface text-fg border border-line-strong hover:bg-surface-2",
  danger: "bg-surface text-danger-text border border-danger/40 hover:bg-danger-soft",
  "danger-solid": "bg-danger text-white border border-transparent hover:brightness-110",
  ghost: "text-muted hover:text-fg hover:bg-subtle border border-transparent",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-xs gap-1.5",
  md: "h-9 px-3.5 text-sm gap-2",
};

export const buttonClass = (variant: ButtonVariant = "secondary", size: ButtonSize = "md"): string =>
  cx(
    "inline-flex shrink-0 items-center justify-center rounded-md font-medium whitespace-nowrap transition-colors select-none disabled:pointer-events-none disabled:opacity-50",
    VARIANT[variant],
    SIZE[size],
  );

export function Button({ variant, size, className, type = "button", ...props }: ComponentProps<"button"> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button type={type} className={cx(buttonClass(variant, size), className)} {...props} />;
}

export const INPUT =
  "w-full rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-sm text-fg placeholder:text-muted/70 transition-colors focus:border-accent focus:outline-none focus-visible:outline-none focus:ring-2 focus:ring-accent/25";

export const LINK = "text-link underline-offset-2 hover:underline";

export type Tone = "neutral" | "accent" | "ok" | "warn" | "danger";

const BADGE_TONE: Record<Tone, string> = {
  neutral: "border-line-strong text-muted",
  accent: "border-accent/40 bg-accent-soft text-link",
  ok: "border-ok/40 bg-ok-soft text-ok",
  warn: "border-warn-line bg-warn-soft text-warn",
  danger: "border-danger/40 bg-danger-soft text-danger-text",
};

export function Badge({ tone = "neutral", dot = false, className, children, ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone; dot?: boolean }) {
  return (
    <span className={cx("inline-flex items-center gap-1 rounded-full border px-2 py-px text-[11px] leading-4 font-medium whitespace-nowrap", BADGE_TONE[tone], className)} {...props}>
      {dot && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

export const CARD = "rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.04)]";

export function Card({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <section className={cx(CARD, "p-4", className)} {...props} />;
}

export function SectionTitle({ children, count, className }: { children: ReactNode; count?: number; className?: string }) {
  return (
    <h2 className={cx("flex items-center gap-2 text-xs font-semibold tracking-wider text-muted uppercase", className)}>
      {children}
      {count !== undefined && <span className="rounded-full bg-subtle px-1.5 py-px text-[11px] tracking-normal text-muted tabular-nums">{count}</span>}
    </h2>
  );
}

const BANNER_TONE: Record<Tone, string> = {
  neutral: "border-line bg-surface-2",
  accent: "border-accent/40 bg-accent-soft",
  ok: "border-ok/40 bg-ok-soft",
  warn: "border-warn-line bg-warn-soft",
  danger: "border-danger/50 bg-danger-soft",
};

const BANNER_ICON: Record<Tone, string> = { neutral: "•", accent: "i", ok: "✓", warn: "!", danger: "!" };
const BANNER_ICON_TONE: Record<Tone, string> = {
  neutral: "bg-line-strong text-fg",
  accent: "bg-accent text-accent-fg",
  ok: "bg-ok text-white dark:text-black",
  warn: "bg-warn-line text-black",
  danger: "bg-danger text-white",
};

// A full-width notice: the state of the Installation, a result of a check, an error.
export function Banner({ tone = "neutral", className, children, action, ...props }: HTMLAttributes<HTMLDivElement> & { tone?: Tone; action?: ReactNode }) {
  return (
    <div className={cx("flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-sm", BANNER_TONE[tone], className)} {...props}>
      <span aria-hidden className={cx("mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold", BANNER_ICON_TONE[tone])}>
        {BANNER_ICON[tone]}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}

// A segmented control: one value of a few, as pressed buttons.
export function Segmented<T extends string | number>({ value, options, onChange, label, size = "md" }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (value: T) => void; label: string; size?: ButtonSize }) {
  return (
    <div className="inline-flex shrink-0 rounded-lg bg-subtle p-0.5" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cx(
            "rounded-md font-medium whitespace-nowrap transition-colors",
            size === "sm" ? "px-2.5 py-0.5 text-xs" : "px-3 py-1 text-sm",
            value === option.value ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <span aria-hidden className={cx("inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent", className)} />;
}

export function CloseIcon() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}
