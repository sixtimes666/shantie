import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type Variant = "primary" | "line" | "quiet";

const variants: Record<Variant, string> = {
  primary: "bg-ink text-sheet",
  line: "border border-line bg-sheet text-ink",
  quiet: "bg-transparent text-muted",
};

export function Button({
  variant = "primary",
  className,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type={type}
      className={cn(
        "press inline-flex min-h-11 items-center justify-center gap-2 rounded-control px-4 text-base font-medium transition-[transform,background-color,color,opacity] duration-150 disabled:pointer-events-none disabled:opacity-40",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}
