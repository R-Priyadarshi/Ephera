import { motion } from 'framer-motion';
import GlassPanel from './GlassPanel';

function TimelineWidget({ events }) {
  return (
    <GlassPanel title="Activity Timeline" subtitle="Session-local events" className="min-h-[260px]" delay={0.22}>
      <div className="space-y-3">
        {events.map((event, index) => (
          <motion.div
            key={`${event.time}-${event.kind}`}
            initial={{ opacity: 0, x: 10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.35, delay: 0.12 + index * 0.05 }}
            className="rounded-xl border border-white/10 bg-white/[0.03] p-3"
          >
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-cyan-100/60">{event.kind}</span>
              <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-white/45">{event.time}</span>
            </div>
            <p className="mt-2 text-sm text-white/80">{event.message}</p>
          </motion.div>
        ))}
      </div>
    </GlassPanel>
  );
}

function LedgerWidget({ rows }) {
  return (
    <GlassPanel title="Transfer Ledger" subtitle="Active + recent streams" className="min-h-[240px]" delay={0.26}>
      <div className="space-y-3">
        {rows.map((row) => (
          <div key={row.id} className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-white">{row.name}</p>
              <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-white/55">{row.status}</span>
            </div>
            <p className="mt-1 text-xs text-white/50">{row.id} • {row.size}</p>
            <div className="mt-2 h-1.5 rounded-full bg-slate-900/80">
              <motion.div
                className="h-full rounded-full bg-gradient-to-r from-cyan-300 to-blue-400"
                initial={{ width: 0 }}
                animate={{ width: `${row.progress}%` }}
                transition={{ duration: 0.9 }}
              />
            </div>
          </div>
        ))}
      </div>
    </GlassPanel>
  );
}

function DiagnosticsWidget({ diagnostics }) {
  return (
    <GlassPanel title="System Diagnostics" subtitle="Trust boundary checks" className="min-h-[220px]" delay={0.3}>
      <div className="space-y-2">
        {diagnostics.map((item) => (
          <div key={item.label} className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2">
            <span className="text-xs text-white/70">{item.label}</span>
            <span className="rounded-lg border border-emerald-300/30 bg-emerald-300/10 px-2 py-1 text-[10px] font-mono uppercase tracking-[0.16em] text-emerald-100">{item.value}</span>
          </div>
        ))}
      </div>
    </GlassPanel>
  );
}

function ReadinessWidget({ readiness }) {
  return (
    <GlassPanel title="Environment Readiness" subtitle="Edge capability matrix" className="min-h-[210px]" delay={0.34}>
      <div className="grid gap-2">
        {readiness.map((item) => (
          <div key={item.label} className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2">
            <span className="text-xs text-white/75">{item.label}</span>
            <motion.span
              className="h-2.5 w-2.5 rounded-full bg-emerald-300"
              animate={{ opacity: [0.4, 1, 0.4] }}
              transition={{ duration: 1.8, repeat: Infinity }}
            />
          </div>
        ))}
      </div>
    </GlassPanel>
  );
}

export default function TelemetryColumn({ events, rows, diagnostics, readiness }) {
  return (
    <div className="col-span-12 space-y-5 xl:col-span-3">
      <TimelineWidget events={events} />
      <LedgerWidget rows={rows} />
      <DiagnosticsWidget diagnostics={diagnostics} />
      <ReadinessWidget readiness={readiness} />
    </div>
  );
}
