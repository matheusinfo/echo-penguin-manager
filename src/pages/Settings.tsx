import { useEffect, useState } from 'react';
import { Settings2, KeyRound, Flame, Wrench } from 'lucide-react';
import { useApp } from '../hooks';
import { NeedsConnection, Page, Tabs } from '../components/ui';
import PenguinTab from './settings/PenguinTab';
import SshTab from './settings/SshTab';
import FirewallTab from './settings/FirewallTab';
import MaintenanceTab from './settings/MaintenanceTab';
import './Settings.css';

type TabId = 'penguin' | 'ssh' | 'firewall' | 'maint';
const TAB_IDS: TabId[] = ['penguin', 'ssh', 'firewall', 'maint'];

export default function SettingsPage() {
  const { connected, pageParams } = useApp();
  const initial = TAB_IDS.includes(pageParams.tab as TabId) ? (pageParams.tab as TabId) : 'penguin';
  const [tab, setTab] = useState<TabId>(initial);
  useEffect(() => {
    if (TAB_IDS.includes(pageParams.tab as TabId)) setTab(pageParams.tab as TabId);
  }, [pageParams.tab]);
  const go = (t: string) => { if (TAB_IDS.includes(t as TabId)) setTab(t as TabId); };

  return (
    <Page title="Configurações" subtitle="echo-penguin: configurações, acesso SSH, firewall e manutenção">
      <NeedsConnection connected={connected}>
        <div className="st-tabs-wrap">
          <Tabs<TabId>
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'penguin', label: <span className="row gap-s"><Settings2 size={14} />Configurações do penguin</span> },
              { id: 'ssh', label: <span className="row gap-s"><KeyRound size={14} />Acesso SSH</span> },
              { id: 'firewall', label: <span className="row gap-s"><Flame size={14} />Firewall &amp; portas</span> },
              { id: 'maint', label: <span className="row gap-s"><Wrench size={14} />Manutenção</span> },
            ]}
          />
        </div>
        {tab === 'penguin' && <PenguinTab onGoTab={go} />}
        {tab === 'ssh' && <SshTab />}
        {tab === 'firewall' && <FirewallTab />}
        {tab === 'maint' && <MaintenanceTab onGoTab={go} />}
      </NeedsConnection>
    </Page>
  );
}
