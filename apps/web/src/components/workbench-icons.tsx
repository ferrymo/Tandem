import type { View } from './collaboration-types';

export function Brand() {
  return (
    <span className="brand">
      <svg
        aria-hidden="true"
        width="30"
        height="30"
        viewBox="0 0 32 32"
        fill="none"
      >
        <path fill="currentColor" d="M3 5h26l-8 8H3z" />
        <path fill="#4386ff" d="m13 13 8-8v16l-8 8z" />
      </svg>
      <strong>Tandem</strong>
    </span>
  );
}
export function NavIcon({ view }: { view: View | 'menu' }) {
  const paths: Partial<Record<View | 'menu', React.ReactNode>> = {
    projects: (
      <>
        <path d="M2 6h6l2 2h8v9H2zM2 6V3h6l2 3" />
      </>
    ),
    documents: (
      <>
        <path d="M5 2h7l4 4v12H5zM12 2v5h4M8 11h5M8 14h5" />
      </>
    ),
    analysis: <path d="M3 3v14h14M7 13V9M11 13V5M15 13V7" />,
    connectors: (
      <path d="m8 12 4-4M7 8l2-2a3 3 0 0 1 5 5l-2 2M8 7l-2 2a3 3 0 0 0 5 5l2-2" />
    ),
    admin: (
      <>
        <path d="m8 2-1 3-3 1 1 3-2 2 2 3 3-1 2 3 3-2 3 1 1-3-2-2 1-3-3-1-1-3z" />
        <circle cx="10" cy="9" r="2.5" />
      </>
    ),
    focus: (
      <>
        <rect x="3" y="3" width="14" height="14" rx="2" />
        <path d="m7 10 2 2 4-5" />
      </>
    ),
    agents: (
      <>
        <circle cx="10" cy="6" r="3" />
        <path d="M4 17v-2a6 6 0 0 1 12 0v2M3 5v5M17 5v5" />
      </>
    ),
    tasks: (
      <>
        <path d="M8 5h9M8 10h9M8 15h9M3 5h1M3 10h1M3 15h1" />
      </>
    ),
    observe: (
      <>
        <path d="M3 3v14h14M7 13V9M11 13V5M15 13V7" />
      </>
    ),
    connect: (
      <>
        <path d="m8 12 4-4M7 8l2-2a3 3 0 0 1 5 5l-2 2M8 7l-2 2a3 3 0 0 0 5 5l2-2" />
      </>
    ),
    capabilities: (
      <>
        <path d="m10 2 7 4v8l-7 4-7-4V6l7-4ZM3 6l7 4 7-4M10 10v8" />
      </>
    ),
    menu: <path d="M3 5h14M3 10h14M3 15h14" />,
  };
  return (
    <svg
      aria-hidden="true"
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[view]}
    </svg>
  );
}
