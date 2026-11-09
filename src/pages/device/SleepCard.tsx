// "Alarme & Tela" → Sono: the sleep diary (`penguin-sleep nights --json`) as a timeline of the last
// 14 nights, and the light sensor against LIGHT_DARK, which decides what counts as "lights off".
// echo-penguin v0.3.0+.
import { AlarmClock, BedDouble, Info, Moon, TriangleAlert } from 'lucide-react';
import { echo } from '../../api';
import { usePoll } from '../../hooks';
import { Card, Empty, ErrorBox, Loading, RefreshButton, Switch, Button } from '../../components/ui';
import { pad2 } from '../alarms';
import { Night, Nights, deviceTime, fmtSleep, hhmm, parseNights, roomState, sleepNightsCmd } from '../sleep';
import { DevState, NeedsVersion, SetLive, calibrateDark, numSetting } from './common';

const DAYS = 14;
const WD = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

export function sleepSupported(data: DevState): boolean {
  return data.features.sleep && 'SLEEP_LOG' in data.defaults;
}

async function loadNights(): Promise<Nights> {
  const r = await echo.exec(sleepNightsCmd(DAYS), { timeout: 30000 });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `penguin-sleep saiu com código ${r.code}`);
  return parseNights(r.stdout);
}

export function SleepCard({ data, busy, setLive }: { data: DevState; busy: string | null; setLive: SetLive }) {
  if (!sleepSupported(data)) {
    return (
      <Card title="Sono" icon={<BedDouble size={16} />}>
        <NeedsVersion data={data} what="Diário de sono" />
      </Card>
    );
  }
  return <SleepBody data={data} busy={busy} setLive={setLive} />;
}

function SleepBody({ data, busy, setLive }: { data: DevState; busy: string | null; setLive: SetLive }) {
  // penguin-sleep is a Python program: read every 5 min, not on each 30 s poll of the page.
  const { data: nights, error, loading, refresh, lastUpdated } = usePoll(loadNights, 5 * 60000);
  const logging = (data.effective.SLEEP_LOG ?? data.defaults.SLEEP_LOG ?? '1') === '1';
  const dark = numSetting(data, 'LIGHT_DARK', 3);
  const room = roomState(data.light, dark);
  const list = nights?.nights ?? [];
  const last = list[0] ?? null;

  return (
    <Card title="Sono" icon={<BedDouble size={16} />}
      actions={<>
        <Switch checked={logging} disabled={busy === 'SLEEP_LOG'} label={<span className="small">Registrar</span>}
          onChange={(v) => setLive('SLEEP_LOG', v ? '1' : '0', v ? 'Diário de sono ligado' : 'Diário de sono desligado: as noites deixam de ser anotadas')} />
        <RefreshButton onClick={refresh} loading={loading} lastUpdated={lastUpdated} />
      </>}>
      <div className="col gap-m">
        {!logging && (
          <div className="dv-note warn"><TriangleAlert size={15} /><div>O registro está desligado (<span className="mono">SLEEP_LOG=0</span>): novas noites não são anotadas.</div></div>
        )}
        {error && <ErrorBox error={error} onRetry={refresh} />}
        {!nights && !error && <Loading />}
        {nights && (
          <div className="dv-sleep-sum">
            <div>
              <div className="stat-label">Média, últimas {Math.min(7, list.length) || 7} noites</div>
              <div className="dv-sleep-big">{fmtSleep(nights.average)}</div>
            </div>
            <div>
              <div className="stat-label">Última noite</div>
              <div className="dv-sleep-big">{last ? fmtSleep(last.minutes) : '—'}</div>
              {last && <div className="muted small">{hhmm(deviceTime(last.bed, data.tzOffsetMin))} → {hhmm(deviceTime(last.wake, data.tzOffsetMin))}</div>}
            </div>
            <div>
              <div className="stat-label">Noites em {DAYS} dias</div>
              <div className="dv-sleep-big">{list.length}</div>
            </div>
          </div>
        )}
        {nights && (list.length === 0
          ? <Empty>Nenhuma noite registrada ainda. O diário anota quando a luz do quarto apaga e acende e quando o alarme para; depois de uma noite inteira ela aparece aqui.</Empty>
          : <SleepTimeline nights={list} tzOffsetMin={data.tzOffsetMin} />)}

        <div className="dv-note">
          <Info size={15} />
          <div className="grow col gap-s">
            <div>
              Luz ambiente agora: <b>{data.light ?? 'sem sensor'}</b>
              {room.state && <> — {room.state === 'dark' ? <b>escuro</b> : room.state === 'lit' ? 'claro' : 'entre escuro e claro'}</>}.
              {' '}O diário conta <b>luz apagada</b> quando a leitura fica em até <b>{dark}</b> <span className="mono muted small">LIGHT_DARK</span> por 2 min,
              e <b>luz acesa</b> acima de <b>{room.litAbove}</b> por 2 min.
            </div>
            <div className="row gap-s wrap">
              <Button size="s" icon={<Moon size={13} />} disabled={data.light == null} busy={busy === 'LIGHT_DARK'} onClick={() => calibrateDark(data, setLive)}
                title="Com a luz do quarto apagada: as leituras até um pouco acima desta contam como escuro">Está escuro agora</Button>
              <span className="field-hint">Com a luz do quarto apagada, se as noites não aparecem (o mesmo ajuste do brilho automático e do relógio noturno).</span>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}

/**
 * One row per night (newest first): the date, a bar from lights off to wake on a shared clock axis,
 * then the same numbers as text (the table view of the chart).
 */
function SleepTimeline({ nights, tzOffsetMin }: { nights: Night[]; tzOffsetMin: number | null }) {
  // Minutes from noon of the day before each wake date (device local time), so a night is one span.
  const rows = nights.map((n) => {
    const [Y, M, D] = n.date.split('-').map(Number);
    const base = Date.UTC(Y, M - 1, D - 1, 12, 0, 0);
    const bed = deviceTime(n.bed, tzOffsetMin);
    const wake = deviceTime(n.wake, tzOffsetMin);
    const wd = new Date(Date.UTC(Y, M - 1, D)).getUTCDay();
    return { n, bed, wake, b: (bed.getTime() - base) / 60000, w: (wake.getTime() - base) / 60000, label: `${WD[wd]} ${pad2(D)}/${pad2(M)}` };
  });
  let lo = Math.floor(Math.min(...rows.map((r) => r.b)) / 60) * 60;
  let hi = Math.ceil(Math.max(...rows.map((r) => r.w)) / 60) * 60;
  lo = Math.max(0, Math.min(lo, 10 * 60));      // show at least 22h…
  hi = Math.min(48 * 60, Math.max(hi, 19 * 60)); // …to 7h
  const span = hi - lo;
  const step = span > 16 * 60 ? 180 : 120;
  const ticks: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) ticks.push(t);
  const pct = (m: number) => `${((Math.min(hi, Math.max(lo, m)) - lo) / span) * 100}%`;
  const hourLabel = (m: number) => `${(12 + Math.round(m / 60)) % 24}h`;

  return (
    <div className="dv-sleep" role="table" aria-label="Noites: apagou, acordou e duração">
      <div className="dv-sleep-row head" role="row">
        <span role="columnheader">Noite</span>
        <span className="dv-sleep-track axis" role="columnheader" aria-label="Linha do tempo">
          {ticks.map((t) => <span key={t} className="dv-sleep-tick" style={{ left: pct(t) }}>{hourLabel(t)}</span>)}
        </span>
        <span role="columnheader">Apagou</span>
        <span role="columnheader">Acordou</span>
        <span role="columnheader">Duração</span>
      </div>
      {rows.map(({ n, bed, wake, b, w, label }) => {
        const tip = `${label}: luz apagada às ${hhmm(bed)}, acordou às ${hhmm(wake)} (${fmtSleep(n.minutes)})` +
          `${n.alarm ? ', com alarme' : ', sem alarme'}`;
        return (
          <div key={n.date} className="dv-sleep-row" role="row" title={tip}>
            <span role="cell" className="nowrap">{label}</span>
            <span role="cell" className="dv-sleep-track">
              {ticks.map((t) => <span key={t} className="dv-sleep-grid" style={{ left: pct(t) }} />)}
              <span className="dv-sleep-bar" style={{ left: pct(b), width: `calc(${pct(w)} - ${pct(b)})` }} />
            </span>
            <span role="cell" className="mono">{hhmm(bed)}</span>
            <span role="cell" className="mono">{hhmm(wake)}{n.alarm && <AlarmClock size={12} className="muted" style={{ marginLeft: 4, verticalAlign: -1 }} aria-label="com alarme" />}</span>
            <span role="cell" className="mono">{fmtSleep(n.minutes)}</span>
          </div>
        );
      })}
    </div>
  );
}
