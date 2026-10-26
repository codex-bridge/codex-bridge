import type { SVGProps } from "react";

function Icon({ children, ...props }: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
    strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{children}</svg>;
}

export function InfoIcon(props: SVGProps<SVGSVGElement>) {
  return <Icon {...props}><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h.01" /></Icon>;
}

export function BellIcon(props: SVGProps<SVGSVGElement>) {
  return <Icon {...props}><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></Icon>;
}

export function LocateIcon(props: SVGProps<SVGSVGElement>) {
  return <Icon {...props}><circle cx="12" cy="12" r="4" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></Icon>;
}

export function PlusIcon(props: SVGProps<SVGSVGElement>) {
  return <Icon {...props}><path d="M12 5v14M5 12h14" /></Icon>;
}

export function RefreshIcon(props: SVGProps<SVGSVGElement>) {
  return <Icon {...props}><path d="M20 11a8 8 0 1 0-2.34 5.66" /><path d="M20 4v7h-7" /></Icon>;
}

export function ToolIcon(props: SVGProps<SVGSVGElement>) {
  return <Icon {...props}><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z" /></Icon>;
}
