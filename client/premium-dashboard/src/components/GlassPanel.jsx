import { motion } from 'framer-motion';

export default function GlassPanel({
  className = '',
  title,
  subtitle,
  right,
  children,
  active = false,
  delay = 0
}) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.42, delay }}
      whileHover={{ y: -4, scale: 1.002 }}
      className={[
        'group relative overflow-hidden rounded-[30px] border border-white/12 bg-[linear-gradient(180deg,rgba(17,32,49,0.9),rgba(7,18,29,0.92))] p-5 shadow-panel backdrop-blur-xl',
        active ? 'shadow-halo ring-1 ring-ephera-cyan/35' : 'hover:border-white/18',
        className
      ].join(' ')}
    >
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(145deg,rgba(255,255,255,0.08),transparent_24%,transparent_78%,rgba(69,215,255,0.08))]" />
      <div className="pointer-events-none absolute inset-[1px] rounded-[29px] border border-white/6" />
      <div className="pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-white/25 to-transparent" />
      <div className="pointer-events-none absolute -right-16 top-[-10%] h-40 w-40 rounded-full bg-cyan-300/8 blur-3xl transition-opacity duration-300 group-hover:opacity-90" />
      {(title || subtitle || right) && (
        <header className="relative z-10 mb-4 flex items-start justify-between gap-4">
          <div>
            {title ? <h3 className="font-display text-lg font-semibold tracking-tight text-white">{title}</h3> : null}
            {subtitle ? <p className="mt-1 text-[10px] font-mono uppercase tracking-[0.22em] text-white/45">{subtitle}</p> : null}
          </div>
          {right ? <div className="shrink-0">{right}</div> : null}
        </header>
      )}
      <div className="relative z-10">{children}</div>
    </motion.section>
  );
}
