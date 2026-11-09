// "Alarme & Tela" → Tela noturna: the dim clock the screen shows in a dark room (NIGHT_CLOCK,
// NIGHT_COLOR). echo-penguin v0.3.0+.
import { Info, Moon } from 'lucide-react';
import { Button, Card } from '../../components/ui';
import { roomState } from '../sleep';
import { Custom, DevState, NeedsVersion, SetLive, SettingSeg, calibrateDark, numSetting } from './common';

const MODE_LABEL: Record<string, string> = { auto: 'quando o quarto escurece', on: 'ligado', off: 'desligado' };
const COLOR_LABEL: Record<string, string> = { red: 'vermelho', amber: 'âmbar' };

export function NightCard({ data, busy, setLive }: { data: DevState; busy: string | null; setLive: SetLive }) {
  if (!('NIGHT_CLOCK' in data.defaults)) {
    return (
      <Card title="Tela noturna" icon={<Moon size={16} />}>
        <NeedsVersion data={data} what="Relógio noturno" />
      </Card>
    );
  }
  const mode = data.effective.NIGHT_CLOCK ?? data.defaults.NIGHT_CLOCK ?? 'auto';
  const dark = numSetting(data, 'LIGHT_DARK', 3);
  const room = roomState(data.light, dark);
  return (
    <Card title="Tela noturna" icon={<Moon size={16} />}>
      <div className="col gap-m">
        <div className="dv-opt">
          <div>
            <div className="dv-opt-title">Relógio noturno <span className="mono muted small">NIGHT_CLOCK</span><Custom data={data} k="NIGHT_CLOCK" /></div>
            <div className="dv-opt-desc">
              Com o quarto escuro e 30 s sem toque na tela, só um relógio fraco (e o próximo alarme) aparece; um toque traz a interface de volta.
              {mode === 'on' && ' Sempre: também com o quarto claro.'}
            </div>
          </div>
          <SettingSeg data={data} k="NIGHT_CLOCK" busy={busy} setLive={setLive}
            okMsg={(v) => `Relógio noturno: ${MODE_LABEL[v] ?? v}`}
            options={[
              { value: 'auto', label: 'Auto', title: 'Quando o quarto escurece (sensor ≤ LIGHT_DARK)' },
              { value: 'on', label: 'Sempre' },
              { value: 'off', label: 'Nunca' },
            ]} />
        </div>
        <div className="dv-opt">
          <div>
            <div className="dv-opt-title">Cor <span className="mono muted small">NIGHT_COLOR</span><Custom data={data} k="NIGHT_COLOR" /></div>
            <div className="dv-opt-desc">Vermelho atrapalha menos a visão no escuro.</div>
          </div>
          <SettingSeg data={data} k="NIGHT_COLOR" busy={busy} setLive={setLive}
            okMsg={(v) => `Relógio noturno em ${COLOR_LABEL[v] ?? v}`}
            options={[
              { value: 'red', label: <><span className="dv-swatch" style={{ background: '#d23a2a' }} />Vermelho</> },
              { value: 'amber', label: <><span className="dv-swatch" style={{ background: '#e29a2b' }} />Âmbar</> },
            ]} />
        </div>
        {mode === 'auto' && (
          <div className="dv-note">
            <Info size={15} />
            <div className="grow col gap-s">
              <div>
                Luz ambiente agora: <b>{data.light ?? 'sem sensor'}</b>
                {room.state && <> — {room.state === 'dark' ? 'escuro' : room.state === 'lit' ? 'claro' : 'entre escuro e claro'}</>}
                {' '}(escuro até <b>{dark}</b> <span className="mono muted small">LIGHT_DARK</span>).
              </div>
              <div className="row gap-s wrap">
                <Button size="s" icon={<Moon size={13} />} disabled={data.light == null} busy={busy === 'LIGHT_DARK'} onClick={() => calibrateDark(data, setLive)}
                  title="Com a luz do quarto apagada: as leituras até um pouco acima desta contam como escuro">Está escuro agora</Button>
                <span className="field-hint">Se o relógio noturno não aparece com a luz apagada.</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
