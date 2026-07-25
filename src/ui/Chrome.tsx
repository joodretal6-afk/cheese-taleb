import { useSim } from '../store/simStore'
import {
  IconAI, IconApi, IconAssets, IconDashboard, IconEnvironment, IconLogout, IconLogs,
  IconMountain, IconPhysics, IconReports, IconSettings, IconSimulation, IconUsers,
  IconVehicle,
} from './icons'

/** Shared dark card used by every dashboard panel. */
export function Panel({
  title,
  actions,
  children,
  className = '',
  bodyClassName = '',
}: {
  title?: string
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
  bodyClassName?: string
}) {
  return (
    <section
      className={`flex min-h-0 flex-col rounded-xl border border-ink-700 bg-ink-850 ${className}`}
    >
      {title && (
        <header className="flex shrink-0 items-center justify-between border-b border-ink-700 px-4 py-3">
          <h2 className="text-[13px] font-semibold text-mist-200">{title}</h2>
          {actions}
        </header>
      )}
      <div className={`min-h-0 flex-1 ${bodyClassName || 'p-4'}`}>{children}</div>
    </section>
  )
}

export function TopBar() {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-ink-700 bg-ink-900 px-4">
      <div className="flex items-center gap-2.5">
        <span className="grid h-8 w-8 place-content-center rounded-lg bg-brand-500/15 text-brand-400">
          <IconMountain className="h-5 w-5" />
        </span>
        <span className="text-[15px] font-semibold tracking-tight text-mist-200" dir="ltr">
          Mud Terrain Simulator
        </span>
      </div>

      <h1 className="text-[15px] font-semibold text-mist-200">لوحة الإدارة</h1>

      <div className="flex items-center gap-3">
        <div className="text-left leading-tight">
          <div className="text-[13px] font-medium text-mist-200">Admin</div>
          <div className="text-[11px] text-mist-400">Super Admin</div>
        </div>
        <span className="grid h-9 w-9 place-content-center rounded-full bg-ink-700 text-mist-400">
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden="true">
            <circle cx="12" cy="8.5" r="3.75" />
            <path d="M4.5 20a7.5 7.5 0 0 1 15 0z" />
          </svg>
        </span>
      </div>
    </header>
  )
}

const NAV = [
  { id: 'dashboard', label: 'لوحة التحكم', Icon: IconDashboard },
  { id: 'vehicles', label: 'المركبات', Icon: IconVehicle },
  { id: 'environment', label: 'البيئة', Icon: IconEnvironment },
  { id: 'physics', label: 'الفيزياء', Icon: IconPhysics },
  { id: 'ai', label: 'الذكاء الصناعي', Icon: IconAI },
  { id: 'assets', label: 'المواد والأصول', Icon: IconAssets },
  { id: 'users', label: 'المستخدمين', Icon: IconUsers },
  { id: 'settings', label: 'الإعدادات', Icon: IconSettings },
  { id: 'logs', label: 'السجلات', Icon: IconLogs },
  { id: 'simulation', label: 'المحاكاة', Icon: IconSimulation },
  { id: 'reports', label: 'التقارير', Icon: IconReports },
  { id: 'api', label: 'API', Icon: IconApi },
]

export function Sidebar() {
  const active = useSim((s) => s.activeSection)
  const setActive = useSim((s) => s.setActiveSection)

  return (
    <nav className="flex w-[212px] shrink-0 flex-col justify-between border-e border-ink-700 bg-ink-900 py-3">
      <ul className="space-y-0.5 px-3">
        {NAV.map(({ id, label, Icon }) => {
          const isActive = active === id
          return (
            <li key={id}>
              <button
                type="button"
                onClick={() => setActive(id)}
                aria-current={isActive ? 'page' : undefined}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-[13px] transition-colors ${
                  isActive
                    ? 'bg-brand-500/15 font-medium text-brand-400'
                    : 'text-mist-400 hover:bg-ink-800 hover:text-mist-200'
                }`}
              >
                <Icon className="h-[18px] w-[18px] shrink-0" />
                <span className="truncate">{label}</span>
              </button>
            </li>
          )
        })}
      </ul>

      <div className="px-3">
        <button
          type="button"
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-[13px] text-mist-400 transition-colors hover:bg-ink-800 hover:text-mist-200"
        >
          <IconLogout className="h-[18px] w-[18px] shrink-0" />
          <span>خروج</span>
        </button>
      </div>
    </nav>
  )
}
