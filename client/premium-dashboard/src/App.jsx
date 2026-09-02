import { useMemo, useState } from 'react';
import FinalCta from './components/FinalCta';
import HeroScene from './components/HeroScene';
import HowToUseSection from './components/HowToUseSection';
import LandingNav from './components/LandingNav';
import PrinciplesMatrix from './components/PrinciplesMatrix';
import ProductPreview from './components/ProductPreview';
import SignalPipelineSection from './components/SignalPipelineSection';
import TrustSection from './components/TrustSection';
import ZeroMemoryArchitecture from './components/ZeroMemoryArchitecture';

const principles = [
  {
    key: 'zero-memory',
    title: 'Zero Memory',
    short: 'Payloads move, then vanish.',
    detail:
      'No payload cache, no server-side copy, no recovery archive. The system is designed so transfer state expires with the session boundary.',
    impact:
      'Operators can reason about runtime clearly because the product never pretends a storage layer exists behind the session.'
  },
  {
    key: 'direct-p2p',
    title: 'Direct P2P',
    short: 'Signal once. Exit the payload path.',
    detail:
      'Signaling coordinates the two endpoints, then steps away. Once the room is real, content moves over a direct WebRTC DataChannel instead of an upload-and-fetch path.',
    impact:
      'Trust collapses down to the sender, the receiver, and the lane they explicitly opened together.'
  },
  {
    key: 'deterministic',
    title: 'Deterministic Transfer',
    short: 'Room, channel, peer, crypto, send.',
    detail:
      'Every visible state maps to a concrete transport threshold. There is no fake syncing phase, hidden queue, or vague processing stage behind the interface.',
    impact:
      'The UI stays legible under pressure because users only see milestones the runtime has actually crossed.'
  },
  {
    key: 'abort-safe',
    title: 'Abort-safe',
    short: 'Failure closes cleanly.',
    detail:
      'Abort is terminal and isolated. Partial completion is never mislabeled as success, and restarting the lane begins from a fresh session boundary.',
    impact:
      'Operational recovery remains simple: close, reopen, and continue without inherited ambiguity or ghost state.'
  }
];

export default function App({ onLaunchDashboard, scrollToSection }) {
  const [activePrinciple, setActivePrinciple] = useState(principles[0].key);

  const scroll = useMemo(() => {
    return typeof scrollToSection === 'function'
      ? scrollToSection
      : (id) => {
          const target = document.getElementById(id);
          if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        };
  }, [scrollToSection]);

  const launchDashboard = useMemo(() => {
    return typeof onLaunchDashboard === 'function' ? onLaunchDashboard : () => scroll('preview');
  }, [onLaunchDashboard, scroll]);

  return (
    <div className="landing-root ephera-premium-landing">
      <LandingNav onLaunchDashboard={launchDashboard} scrollToSection={scroll} />

      <main className="relative z-10">
        <HeroScene onLaunchDashboard={launchDashboard} scrollToSection={scroll} />
        <SignalPipelineSection />
        <HowToUseSection onLaunchDashboard={launchDashboard} />
        <ZeroMemoryArchitecture />
        <ProductPreview />
        <PrinciplesMatrix
          activePrinciple={activePrinciple}
          principles={principles}
          onSelect={setActivePrinciple}
        />
        <TrustSection />
        <FinalCta onLaunchDashboard={launchDashboard} scrollToSection={scroll} />
      </main>
    </div>
  );
}
