import { motion } from 'framer-motion';
import GlassPanel from './GlassPanel';

function ConsoleRow({ label, value, active }) {
  return (
    <div
      className={[
        'flex items-center justify-between rounded-xl border px-3 py-2',
        active ? 'border-cyan-300/35 bg-cyan-300/10 text-cyan-50' : 'border-white/10 bg-white/[0.03] text-white/80'
      ].join(' ')}
    >
      <span className="text-[10px] font-mono uppercase tracking-[0.2em] text-white/50">{label}</span>
      <span className="text-sm font-medium">{value}</span>
    </div>
  );
}

function SessionOperations() {
  return (
    <GlassPanel
      className="min-h-[290px]"
      title="Session Fabric"
      subtitle="Room creation / join control"
      right={<span className="rounded-lg border border-cyan-300/30 bg-cyan-300/10 px-2 py-1 text-[10px] font-mono uppercase tracking-[0.18em] text-cyan-100">Primary</span>}
      active
      delay={0.16}
    >
      <div className="grid gap-3">
        <ConsoleRow label="Room" value="eph-0f2a-71" active />
        <ConsoleRow label="Authority" value="owner" />
        <ConsoleRow label="Invite Package" value="signed + synced" />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <button type="button" className="rounded-xl border border-cyan-300/35 bg-cyan-300/15 px-3 py-2 text-xs font-mono uppercase tracking-[0.16em] text-cyan-100">Open Secure Room</button>
        <button type="button" className="rounded-xl border border-white/15 bg-white/[0.04] px-3 py-2 text-xs font-mono uppercase tracking-[0.16em] text-white/80">Join Existing</button>
        <button type="button" className="rounded-xl border border-white/15 bg-white/[0.04] px-3 py-2 text-xs font-mono uppercase tracking-[0.16em] text-white/80">Copy Invite</button>
        <button type="button" className="rounded-xl border border-white/15 bg-white/[0.04] px-3 py-2 text-xs font-mono uppercase tracking-[0.16em] text-white/80">QR Handoff</button>
      </div>

      <div className="mt-4 rounded-xl border border-white/10 bg-slate-950/40 p-3">
        <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-white/50">Session command stream</p>
        <div className="mt-2 flex items-center gap-2">
          {[...Array(9)].map((_, i) => (
            <motion.span
              key={i}
              className="h-1.5 flex-1 rounded-full bg-cyan-300/30"
              animate={{ opacity: [0.25, 0.9, 0.25] }}
              transition={{ duration: 1.4, repeat: Infinity, delay: i * 0.08 }}
            />
          ))}
        </div>
      </div>
    </GlassPanel>
  );
}

function ReceiveOperations() {
  return (
    <GlassPanel
      className="min-h-[240px]"
      title="Receive Console"
      subtitle="Destination + policy"
      right={<span className="rounded-lg border border-emerald-300/30 bg-emerald-300/10 px-2 py-1 text-[10px] font-mono uppercase tracking-[0.18em] text-emerald-100">Ready</span>}
      delay={0.22}
    >
      <div className="grid gap-2">
        <ConsoleRow label="Mode" value="Saved stream" active />
        <ConsoleRow label="Directory" value="/vault/live-drop" />
        <ConsoleRow label="Integrity" value="checksum rolling" />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <button type="button" className="rounded-xl border border-emerald-300/35 bg-emerald-300/15 px-3 py-2 text-xs font-mono uppercase tracking-[0.16em] text-emerald-100">Pick Receive Path</button>
        <button type="button" className="rounded-xl border border-white/15 bg-white/[0.04] px-3 py-2 text-xs font-mono uppercase tracking-[0.16em] text-white/80">Discard Mode</button>
      </div>
    </GlassPanel>
  );
}

function SendOperations() {
  return (
    <GlassPanel
      className="min-h-[310px]"
      title="Send Operations"
      subtitle="Payload orchestration"
      right={<span className="rounded-lg border border-orange-300/35 bg-orange-300/10 px-2 py-1 text-[10px] font-mono uppercase tracking-[0.18em] text-orange-100">Armed</span>}
      delay={0.28}
    >
      <div className="rounded-2xl border border-dashed border-cyan-300/35 bg-cyan-300/5 p-5 text-center">
        <p className="font-display text-lg font-medium text-cyan-100">Drop Files / Folder</p>
        <p className="mt-1 text-xs text-white/60">Hierarchy preserved, stream chunking enabled</p>
      </div>

      <div className="mt-4 grid gap-2">
        <ConsoleRow label="Queue" value="4 files staged" />
        <ConsoleRow label="Total" value="2.7 GB" />
        <ConsoleRow label="Priority" value="Weighted high" active />
      </div>

      <div className="mt-4 flex gap-2">
        <button type="button" className="flex-1 rounded-xl border border-cyan-300/40 bg-cyan-300/15 px-3 py-2 text-xs font-mono uppercase tracking-[0.16em] text-cyan-100">Initiate Stream</button>
        <button type="button" className="rounded-xl border border-white/15 bg-white/[0.04] px-3 py-2 text-xs font-mono uppercase tracking-[0.16em] text-white/80">Abort</button>
      </div>
    </GlassPanel>
  );
}

export default function OperationsColumn() {
  return (
    <div className="col-span-12 space-y-5 xl:col-span-4">
      <SessionOperations />
      <ReceiveOperations />
      <SendOperations />
    </div>
  );
}
