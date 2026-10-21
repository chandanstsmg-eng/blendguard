import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const badgeVariants = cva('inline-flex items-center gap-1.5 rounded-md font-semibold whitespace-nowrap [&_svg]:size-4', {
  variants: {
    tone: {
      neutral: 'bg-mist text-ink',
      navy: 'bg-navy text-white',
      ok: 'bg-ok-100 text-ok',
      warn: 'bg-warn-100 text-[#8a5a00]',
      err: 'bg-err-100 text-err',
      orange: 'bg-orange-100 text-[#8a4a12]',
    },
    size: { sm: 'px-2 py-0.5 text-xs', md: 'px-2.5 py-1 text-sm', lg: 'px-3 py-1.5 text-base' },
  },
  defaultVariants: { tone: 'neutral', size: 'md' },
});

export function Badge({ className, tone, size, ...props }: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone, size }), className)} {...props} />;
}
