import { motion } from 'framer-motion';

function PreviewNav() {
  return (
    <div className="grid grid-cols-[1.2fr_0.9fr_1fr] items-center gap-4 rounded-[26px] border border-white/10 bg-white/[0.04] px-5 py-4">
      <div className="flex items-center gap-4">
        <div className="h-9 w-9 rounded-xl border border-cyan-300/22 bg-cyan-300/10" />
        <div>
          <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-cyan-100/56">Ephera live cockpit</p>
          <p className="text-sm text-white/88">Transfer boundary online</p>
        </div>
      </div>
      <div className="flex items-center gap-2 rounded-full border border-white/10 bg-[#061321] px-3 py-2">
        <motion.span
          className="h-2.5 w-2.5 rounded-full bg-emerald-300"
          animate={{ opacity: [0.4, 1, 0.4], scale: [1, 1.24, 1] }}
          transition={{ duration: 2, repeat: Infinity }}
        />
        <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-white/58">
          direct path verified
        </span>
      </div>
      <div className="flex justify-end gap-2">
        {['Session', 'Transfer', 'Security'].map((item) => (
          <span
            key={item}
            className="rounded-full border border-white/10 bg-white/[0.035] px-3 py-2 text-[10px] font-mono uppercase tracking-[0.16em] text-white/65"
          >
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

function PacketMap() {
  return (
    <div className="relative h-[280px] overflow-hidden rounded-[28px] border border-white/10 bg-[radial-gradient(circle_at_40%_28%,rgba(34,90,180,0.35),transparent_26%),linear-gradient(180deg,rgba(9,18,29,0.95),rgba(7,12,21,0.96))] p-5">
      <div className="absolute inset-0 opacity-[0.18] [background-image:linear-gradient(rgba(255,255,255,0.06)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.06)_1px,transparent_1px)] [background-size:42px_42px]" />
      <div className="absolute left-[15%] top-[62%] h-px w-[32%] rotate-[8deg] bg-gradient-to-r from-cyan-300/60 to-transparent" />
      <div className="absolute left-[42%] top-[42%] h-px w-[18%] rotate-[-22deg] bg-gradient-to-r from-sky-300/60 to-transparent" />
      <div className="absolute left-[58%] top-[48%] h-px w-[18%] rotate-[18deg] bg-gradient-to-r from-cyan-300/50 to-emerald-300/60" />
      {[
        ['Sender', '16%', '66%', 'bg-cyan-300'],
        ['Signal', '44%', '46%', 'bg-orange-300'],
        ['Peer', '60%', '56%', 'bg-emerald-300'],
        ['Crypto', '74%', '34%', 'bg-indigo-300'],
        ['Receiver', '86%', '62%', 'bg-sky-300']
      ].map(([label, x, y, tone], index) => (
        <motion.div
          key={label}
          className="absolute"
          style={{ left: x, top: y }}
          animate={{ scale: [1, 1.14, 1], opacity: [0.55, 1, 0.55] }}
          transition={{ duration: 2.6, repeat: Infinity, delay: index * 0.16 }}
        >
          <div className={`h-3.5 w-3.5 rounded-full ${tone}`} />
          <p className="mt-2 text-[10px] font-mono uppercase tracking-[0.18em] text-white/46">{label}</p>
        </motion.div>
      ))}
      {[0, 0.9, 1.8].map((delay) => (
        <motion.div
          key={delay}
          className="absolute left-[18%] top-[58%] h-3 w-3 rounded-full bg-cyan-200 shadow-[0_0_18px_rgba(113,240,255,0.9)]"
          animate={{
            x: [0, 94, 178, 248, 332],
            y: [0, -18, 10, -18, 4],
            opacity: [0, 1, 1, 1, 0]
          }}
          transition={{ duration: 3.2, repeat: Infinity, delay, ease: 'easeInOut' }}
        />
      ))}
    </div>
  );
}

function ProductRail() {
  return (
    <div className="grid gap-4">
      <div className="rounded-[28px] border border-white/10 bg-white/[0.035] p-5">
        <div className="mb-5 flex items-center justify-between">
          <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-cyan-100/56">Transfer flow</p>
          <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-white/42">arming sequence</p>
        </div>
        <div className="grid gap-2">
          {[
            ['Room', 'Ready'],
            ['Channel', 'Direct'],
            ['Peer', 'Confirmed'],
            ['Crypto', 'Verified'],
            ['Transfer', 'Streaming']
          ].map(([label, value], index) => (
            <motion.div
              key={label}
              className="grid grid-cols-[80px_1fr_auto] items-center gap-3 rounded-2xl border border-white/10 bg-[#091522] px-3 py-3"
              animate={{ borderColor: ['rgba(255,255,255,0.08)', 'rgba(69,215,255,0.18)', 'rgba(255,255,255,0.08)'] }}
              transition={{ duration: 2.4, repeat: Infinity, delay: index * 0.14 }}
            >
              <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-white/42">{label}</span>
              <div className="h-1.5 rounded-full bg-white/8">
                <div className="h-full rounded-full bg-gradient-to-r from-cyan-300 via-sky-300 to-emerald-300" />
              </div>
              <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-cyan-100/62">{value}</span>
            </motion.div>
          ))}
        </div>
      </div>

      <div className="rounded-[28px] border border-white/10 bg-white/[0.03] p-5">
        <div className="mb-4 flex items-center justify-between">
          <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-cyan-100/56">Bandwidth trace</p>
          <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-white/42">live</p>
        </div>
        <div className="relative h-28 overflow-hidden rounded-2xl border border-white/10 bg-[#091522] p-3">
          <svg viewBox="0 0 300 100" className="h-full w-full">
            <motion.path
              d="M0 70 C20 55 35 42 58 48 C78 54 92 80 120 68 C142 58 168 22 190 36 C214 50 240 70 260 54 C276 40 288 26 300 18"
              fill="none"
              stroke="rgba(69,215,255,0.95)"
              strokeWidth="2.5"
              initial={{ pathLength: 0 }}
              whileInView={{ pathLength: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 1.2 }}
            />
          </svg>
          <motion.div
            className="absolute inset-y-0 w-12 bg-gradient-to-r from-transparent via-cyan-300/18 to-transparent"
            animate={{ x: ['-10%', '600%'] }}
            transition={{ duration: 2.8, repeat: Infinity, ease: 'linear' }}
          />
        </div>
      </div>
    </div>
  );
}

export default function ProductPreview() {
  return (
    <section id="preview" className="px-4 py-24 md:px-8 xl:px-12">
      <div className="mx-auto grid w-full max-w-[1820px] grid-cols-12 gap-8">
        <div className="col-span-12 xl:col-span-4">
          <p className="text-[11px] font-mono uppercase tracking-[0.3em] text-cyan-100/52">Live Product Preview</p>
          <h2 className="mt-5 max-w-[9ch] font-display text-[clamp(2.8rem,5vw,5rem)] font-semibold uppercase leading-[0.92] tracking-[-0.06em] text-white">
            The transport should look alive while it runs.
          </h2>
          <p className="mt-8 max-w-md text-lg leading-8 text-white/62">
            This is not a storage dashboard with transfer bolted on. It is an operational cockpit built around
            the direct path itself.
          </p>
        </div>

        <div className="col-span-12 xl:col-span-8">
          <div className="overflow-hidden rounded-[42px] border border-white/10 bg-[linear-gradient(180deg,rgba(10,18,29,0.92),rgba(4,10,17,0.98))] p-6 shadow-[0_40px_140px_rgba(0,0,0,0.5)]">
            <PreviewNav />

            <div className="mt-5 grid gap-5 xl:grid-cols-[1.4fr_0.75fr]">
              <div className="grid gap-5">
                <PacketMap />
                <div className="grid gap-5 lg:grid-cols-[1.1fr_0.9fr]">
                  <div className="rounded-[28px] border border-white/10 bg-white/[0.03] p-5">
                    <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-cyan-100/56">
                      Session console
                    </p>
                    <div className="mt-5 grid gap-3 sm:grid-cols-3">
                      {[
                        ['Room', 'eph-07c3'],
                        ['Peer', 'ready'],
                        ['Crypto', 'passphrase match']
                      ].map(([label, value]) => (
                        <div key={label} className="rounded-2xl border border-white/10 bg-[#091522] px-4 py-4">
                          <p className="text-[10px] font-mono uppercase tracking-[0.18em] text-white/42">{label}</p>
                          <p className="mt-3 text-sm text-white/86">{value}</p>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-[28px] border border-white/10 bg-white/[0.03] p-5">
                    <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-cyan-100/56">
                      Secure stream
                    </p>
                    <div className="mt-5 space-y-4">
                      {[
                        ['Throughput', '2.6 Gbps'],
                        ['Chunk envelope', '64 KB'],
                        ['Abort posture', 'terminal + isolated']
                      ].map(([label, value]) => (
                        <div key={label} className="flex items-center justify-between border-b border-white/10 pb-3 last:border-none">
                          <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-white/42">{label}</span>
                          <span className="text-sm text-white/84">{value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              <ProductRail />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
