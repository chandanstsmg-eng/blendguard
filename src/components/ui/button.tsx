import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * shadcn/ui-style button, sized for gloved fingers. `xl` and `lg` are the
 * operator sizes (≥ 64 px tall); `md`/`sm` are for the supervisor console.
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-3 rounded-lg font-semibold transition-[background-color,box-shadow,transform,filter] duration-100 select-none ' +
    'focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-orange/50 active:translate-y-px active:brightness-95 ' +
    'disabled:cursor-not-allowed disabled:opacity-100 disabled:bg-mist disabled:text-muted disabled:border-line disabled:shadow-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-orange text-navy-900 shadow-[0_3px_0_0_#a85c1c] hover:bg-orange-600',
        navy: 'bg-navy text-white shadow-[0_3px_0_0_#0b1d28] hover:bg-blue',
        success: 'bg-ok text-white shadow-[0_3px_0_0_#17603a] hover:brightness-105',
        danger: 'bg-err text-white shadow-[0_3px_0_0_#8e2b2b] hover:brightness-105',
        outline: 'border-2 border-navy bg-white text-navy hover:bg-mist',
        ghost: 'text-navy hover:bg-mist',
        quiet: 'bg-white/10 text-white hover:bg-white/20',
      },
      size: {
        xl: 'min-h-24 px-8 font-display text-3xl uppercase tracking-wide [&_svg]:size-9',
        lg: 'min-h-16 px-6 font-display text-2xl uppercase tracking-wide [&_svg]:size-7',
        md: 'h-11 px-4 text-base [&_svg]:size-5',
        sm: 'h-9 px-3 text-sm [&_svg]:size-4',
        icon: 'size-11 [&_svg]:size-5',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : 'button';
  return <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
});
Button.displayName = 'Button';

export { buttonVariants };
