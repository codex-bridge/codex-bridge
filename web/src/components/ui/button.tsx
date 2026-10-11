// shadcn/ui Button primitive, adapted to this workbench's semantic tokens.
import type { ComponentProps } from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const buttonVariants = cva("button inline-flex items-center justify-center gap-2 whitespace-nowrap", {
  variants: { variant: { default: "button-primary", outline: "button-outline", ghost: "button-ghost", destructive: "button-danger" } },
  defaultVariants: { variant: "default" }
});
export function Button({ className, variant, asChild = false, ...props }: ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant, className }))} {...props} />;
}
