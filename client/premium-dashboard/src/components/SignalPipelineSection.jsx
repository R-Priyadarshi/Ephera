import { motion } from 'framer-motion';

const steps = [
  { label: 'ROOM', note: 'Boundary opens' },
  { label: 'SIGNAL', note: 'Peers rendezvous' },
  { label: 'CHANNEL', note: 'Direct lane forms' },
  { label: 'PEER', note: 'Receiver confirms' },
  { label: 'CRYPTO', note: 'Envelope verifies' },
  { label: 'TRANSFER', note: 'Payload streams' }
];

export default function SignalPipelineSection() {
  return (
    <section id="pipeline" className="px-4 py-24 md:px-8 xl:px-12">
      <div className="mx-auto grid w-full max-w-[1820px] grid-cols-12 gap-8">
        <div className="col-span-12 xl:col-span-3">
          <p className="text-[11px] font-mono uppercase tracking-[0.3em] text-cyan-100/52">System Visual Story</p>
          <h2 className="mt-5 max-w-[9ch] font-display text-[clamp(2.8rem,5vw,5rem)] font-semibold uppercase leading-[0.92] tracking-[-0.06em] text-white">
            The transport lights up in sequence.
          </h2>
        </div>

        <div className="col-span-12 xl:col-span-9">
          <div className="grid gap-4 lg:grid-cols-6">
            {steps.map((step, index) => (
              <motion.article
                key={step.label}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, amount: 0.5 }}
                transition={{ duration: 0.45, delay: index * 0.06 }}
                className="group relative overflow-hidden rounded-[28px] border border-white/10 bg-[linear-gradient(180deg,rgba(12,22,36,0.82),rgba(6,13,21,0.92))] p-5 backdrop-blur-xl"
              >
                <motion.div
                  className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-cyan-300 via-sky-300 to-emerald-300"
                  animate={{ opacity: [0.22, 0.9, 0.22] }}
                  transition={{ duration: 2.2, repeat: Infinity, delay: index * 0.14 }}
                />
                <div className="relative z-10">
                  <p className="text-[10px] font-mono uppercase tracking-[0.24em] text-white/40">
                    Step {index + 1}
                  </p>
                  <p className="mt-6 font-display text-2xl font-semibold tracking-tight text-white">{step.label}</p>
                  <p className="mt-6 text-sm text-white/62">{step.note}</p>
                </div>
                <motion.div
                  aria-hidden="true"
                  className="absolute bottom-4 left-5 h-2 w-2 rounded-full bg-cyan-300 shadow-[0_0_18px_rgba(69,215,255,0.7)]"
                  animate={{ x: [0, 42, 0], opacity: [0.35, 1, 0.35] }}
                  transition={{ duration: 2.4, repeat: Infinity, delay: index * 0.12 }}
                />
              </motion.article>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
