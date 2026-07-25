/** Inline stroke icons — no icon package, so the desktop build stays offline. */

type P = { className?: string }
const base = 'h-[18px] w-[18px]'

function Svg({ className, children }: P & { children: React.ReactNode }) {
  return (
    <svg
      className={className ?? base}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

export const IconDashboard = (p: P) => (
  <Svg {...p}>
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5 9.5V21h14V9.5" />
    <path d="M9.5 21v-6h5v6" />
  </Svg>
)
export const IconVehicle = (p: P) => (
  <Svg {...p}>
    <path d="M3 13.5h18" />
    <path d="M5 13.5 6.6 8.4A2 2 0 0 1 8.5 7h7a2 2 0 0 1 1.9 1.4L19 13.5V18h-2.5" />
    <path d="M7.5 18H5v-4.5" />
    <circle cx="8" cy="18" r="1.8" />
    <circle cx="16" cy="18" r="1.8" />
  </Svg>
)
export const IconEnvironment = (p: P) => (
  <Svg {...p}>
    <path d="M3 19h18" />
    <path d="m3 19 6-9 4 5.5 2-2.5 6 6" />
    <circle cx="17" cy="6.5" r="2.5" />
  </Svg>
)
export const IconPhysics = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="2" />
    <ellipse cx="12" cy="12" rx="9.5" ry="4" />
    <ellipse cx="12" cy="12" rx="9.5" ry="4" transform="rotate(60 12 12)" />
    <ellipse cx="12" cy="12" rx="9.5" ry="4" transform="rotate(120 12 12)" />
  </Svg>
)
export const IconAI = (p: P) => (
  <Svg {...p}>
    <rect x="5" y="7" width="14" height="12" rx="3" />
    <path d="M12 7V4" />
    <circle cx="12" cy="3" r="1" />
    <path d="M9.5 12v2M14.5 12v2" />
    <path d="M2.5 12.5v3M21.5 12.5v3" />
  </Svg>
)
export const IconAssets = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="3" width="8" height="8" rx="1.5" />
    <rect x="13" y="3" width="8" height="8" rx="1.5" />
    <rect x="3" y="13" width="8" height="8" rx="1.5" />
    <rect x="13" y="13" width="8" height="8" rx="1.5" />
  </Svg>
)
export const IconUsers = (p: P) => (
  <Svg {...p}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3 19a6 6 0 0 1 12 0" />
    <path d="M16 6.2a3 3 0 0 1 0 5.6" />
    <path d="M17.5 14.2A5.5 5.5 0 0 1 21 19" />
  </Svg>
)
export const IconSettings = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8" />
  </Svg>
)
export const IconLogs = (p: P) => (
  <Svg {...p}>
    <rect x="4" y="3" width="16" height="18" rx="2" />
    <path d="M8 8h8M8 12h8M8 16h5" />
  </Svg>
)
export const IconSimulation = (p: P) => (
  <Svg {...p}>
    <path d="M4 4v16h16" />
    <path d="m6 15 4-5 3 3 5-7" />
  </Svg>
)
export const IconReports = (p: P) => (
  <Svg {...p}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
    <path d="M9 13h6M9 17h4" />
  </Svg>
)
export const IconApi = (p: P) => (
  <Svg {...p}>
    <path d="m9 8-4 4 4 4M15 8l4 4-4 4" />
  </Svg>
)
export const IconLogout = (p: P) => (
  <Svg {...p}>
    <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" />
    <path d="M10 8 6 12l4 4M6 12h9" />
  </Svg>
)

export const IconSun = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.5 1.5M17.6 17.6l1.5 1.5M19.1 4.9l-1.5 1.5M6.4 17.6l-1.5 1.5" />
  </Svg>
)
export const IconRain = (p: P) => (
  <Svg {...p}>
    <path d="M7 15a4 4 0 0 1 .5-8 5.5 5.5 0 0 1 10.4 1.4A3.5 3.5 0 0 1 17.5 15z" />
    <path d="M8.5 18.5 7.5 21M12.5 18.5 11.5 21M16.5 18.5 15.5 21" />
  </Svg>
)
export const IconCloud = (p: P) => (
  <Svg {...p}>
    <path d="M7 18a4.5 4.5 0 0 1 .4-9A5.8 5.8 0 0 1 18.2 10.4 3.9 3.9 0 0 1 17.6 18z" />
  </Svg>
)
export const IconSnow = (p: P) => (
  <Svg {...p}>
    <path d="M12 3v18M4.2 7.5l15.6 9M19.8 7.5l-15.6 9" />
  </Svg>
)
export const IconSearch = (p: P) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="6" />
    <path d="m20 20-4.5-4.5" />
  </Svg>
)
export const IconSparkles = (p: P) => (
  <Svg {...p}>
    <path d="M12 4.5 13.4 9l4.6 1.5-4.6 1.5L12 16.5 10.6 12 6 10.5 10.6 9z" />
    <path d="M18.5 3.5 19 5l1.5.5L19 6l-.5 1.5L18 6l-1.5-.5L18 5z" />
  </Svg>
)
export const IconPlay = (p: P) => (
  <Svg {...p}>
    <path d="M7 4.5 19 12 7 19.5z" />
  </Svg>
)
export const IconStop = (p: P) => (
  <Svg {...p}>
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </Svg>
)
export const IconExpand = (p: P) => (
  <Svg {...p}>
    <path d="M4 9V4h5M20 15v5h-5M15 4h5v5M9 20H4v-5" />
  </Svg>
)
export const IconClose = (p: P) => (
  <Svg {...p}>
    <path d="m6 6 12 12M18 6 6 18" />
  </Svg>
)
export const IconMountain = (p: P) => (
  <Svg {...p}>
    <path d="m2 19 7-11 4.5 7 2.5-3.5L22 19z" />
  </Svg>
)
export const IconCheck = (p: P) => (
  <Svg {...p}>
    <path d="m5 12.5 4.5 4.5L19 7" />
  </Svg>
)
export const IconReset = (p: P) => (
  <Svg {...p}>
    <path d="M4 12a8 8 0 1 1 2.5 5.8" />
    <path d="M4 18v-5h5" />
  </Svg>
)
