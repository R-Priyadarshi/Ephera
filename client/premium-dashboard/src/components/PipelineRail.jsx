import { motion } from 'framer-motion';

const stateColors = {
  online: 'bg-emerald-300 shadow-[0_0_0_6px_rgba(89,243,200,0.15)]',
  negotiating: 'bg-cyan-300 shadow-[0_0_0_6px_rgba(69,215,255,0.15)]',
  ready: 'bg-sky-300 shadow-[0_0_0_6px_rgba(47,139,255,0.15)]',
  verified: 'bg-indigo-300 shadow-[0_0_0_6px_rgba(104,122,255,0.2)]',
  armed: 'bg-orange-300 shadow-[0_0_0_6px_rgba(248,160,107,0.22)]'
};

export default function PipelineRail({ stages }) {
  return (
    <div className="relative mt-5 rounded-2xl border border-white/10 bg-slate-900/60 p-4">
      <div className="absolute left-8 right-8 top-1/2 h-[2px] -translate-y-1/2 bg-gradient-to-r from-cyan-300/40 via-blue-400/50 to-orange-300/45" />
      <div className="relative z-10 grid grid-cols-5 gap-3">
        {stages.map((stage, index) => (
          <div key={stage.key} className="text-center">
            <motion.div
              className={`mx-auto mb-2 h-4 w-4 rounded-full ${stateColors[stage.state]}`}
              animate={{ scale: [1, 1.22, 1], opacity: [0.7, 1, 0.7] }}
              transition={{ duration: 2 + index * 0.15, repeat: Infinity }}
            />
            <p className="text-[10px] font-mono uppercase tracking-[0.18em] text-white/55">{stage.label}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
