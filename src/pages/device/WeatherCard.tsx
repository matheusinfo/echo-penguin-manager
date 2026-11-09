// "Alarme & Tela" → Clima: the weather location (searched by city name) and what penguin-weather last
// fetched (/run/penguin/weather.json). echo-penguin v0.3.0+.
import { useState } from 'react';
import { CloudSun, MapPin, RefreshCw, Search, Trash2, TriangleAlert, Umbrella } from 'lucide-react';
import { echo, errMsg, run } from '../../api';
import { useApp } from '../../hooks';
import { Badge, Button, Card, Empty } from '../../components/ui';
import { deviceTime, hhmm } from '../sleep';
import {
  Place, WEATHER_CREDIT, WEATHER_CREDIT_URL, WEATHER_STALE_S, cityQueryError, currentToday, findPlaces, locationCommand, placeLabel,
  rainText, updateWeather, weatherText,
} from '../weather';
import { DevState, NeedsVersion, deviceNowMs } from './common';

export function weatherSupported(data: DevState): boolean {
  return data.features.weather && 'WEATHER_LAT' in data.defaults;
}

function ago(seconds: number): string {
  if (seconds < 90) return 'agora há pouco';
  if (seconds < 3600) return `há ${Math.round(seconds / 60)} min`;
  const h = Math.floor(seconds / 3600);
  return h < 48 ? `há ${h} h` : `há ${Math.floor(h / 24)} dias`;
}

export function WeatherCard({ data, refresh }: { data: DevState; refresh: () => void }) {
  const { confirm, toast } = useApp();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Place[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  if (!weatherSupported(data)) {
    return (
      <Card title="Clima" icon={<CloudSun size={16} />}>
        <NeedsVersion data={data} what="Clima na tela e na fala" />
      </Card>
    );
  }

  const eff = data.effective;
  const lat = eff.WEATHER_LAT ?? '', lon = eff.WEATHER_LON ?? '';
  const place = eff.WEATHER_PLACE ?? '';
  const hasLocation = lat !== '' && lon !== '';
  const w = data.weather;
  const nowS = deviceNowMs(data) / 1000;
  const age = w?.fetched != null ? nowS - w.fetched : null;
  const stale = age != null && age > WEATHER_STALE_S;
  const today = w ? currentToday(w, nowS) : null;
  // The cache keeps the last good data: after a location change whose update failed, it is the old place's.
  const otherPlace = w && hasLocation && w.lat != null && w.lon != null &&
    (Math.abs(w.lat - Number(lat)) > 0.01 || Math.abs(w.lon - Number(lon)) > 0.01);

  const withBusy = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  const doUpdate = () => withBusy('update', async () => {
    const r = await updateWeather();
    if (r.ok) toast('Clima atualizado', 'ok');
    else if (r.noLocation) toast('Nenhum local configurado', 'info');
    else toast(`Falha ao atualizar o clima: ${r.message}`, 'error');
    refresh();
  });

  const search = () => withBusy('search', async () => {
    const err = cityQueryError(query);
    if (err) throw new Error(err);
    setResults(await findPlaces(query));
  });

  const choose = (p: Place) => withBusy('set', async () => {
    await run(locationCommand(p, data.defaults));
    setResults(null);
    setQuery('');
    const r = await updateWeather();
    if (r.ok) toast(`Local do clima: ${placeLabel(p)}`, 'ok');
    else toast(`Local salvo (${placeLabel(p)}), mas a atualização falhou: ${r.message}`, 'error');
    refresh();
  });

  const clear = async () => {
    if (!(await confirm({
      title: 'Remover o local do clima',
      message: 'WEATHER_LAT, WEATHER_LON e WEATHER_PLACE voltam a vazio: a tela deixa de mostrar o clima e a fala depois do alarme diz só a hora.',
      confirmLabel: 'Remover',
    }))) return;
    await withBusy('clear', async () => {
      await run(locationCommand(null, data.defaults));
      // With no location, update removes the cached forecast (exit 2), so the screen stops showing it.
      const r = await updateWeather();
      if (!r.ok && !r.noLocation) throw new Error(`Local removido, mas o clima antigo continua na tela: ${r.message}`);
      toast('Local do clima removido', 'ok');
      refresh();
    });
  };

  return (
    <Card title="Clima" icon={<CloudSun size={16} />}
      actions={hasLocation && <Button size="s" variant="ghost" icon={<RefreshCw size={13} />} busy={busy === 'update'} onClick={doUpdate}
        title="penguin-weather update">Atualizar agora</Button>}>
      <div className="col gap-m">
        <div className="row gap-s wrap">
          <MapPin size={15} className="muted" />
          {hasLocation
            ? <><b>{place || 'Local sem nome'}</b> <span className="muted small mono">{lat}, {lon}</span></>
            : <span className="muted">Nenhum local: o clima está desligado.</span>}
          {hasLocation && <Button size="s" variant="ghost" icon={<Trash2 size={13} />} busy={busy === 'clear'} onClick={clear}>Remover</Button>}
        </div>

        {hasLocation && (w ? (
          <div className="dv-weather">
            {w.now && (
              <div className="row gap-m">
                <span className="dv-weather-temp">{w.now.temp != null ? `${Math.round(w.now.temp)}°` : '—'}</span>
                <div className="col">
                  <span>{weatherText(w.now) || '—'}</span>
                  {today && <span className="muted small">mín {fmtDeg(today.min)} · máx {fmtDeg(today.max)}</span>}
                </div>
              </div>
            )}
            {rainText(today) && <div className="small"><Umbrella size={13} style={{ verticalAlign: -2 }} /> {rainText(today)}</div>}
            <div className="muted small">
              {w.fetched != null ? <>Dados das {hhmm(deviceTime(w.fetched, data.tzOffsetMin))} ({ago(age ?? 0)})</> : 'Sem dados ainda'}
              {stale && <Badge tone="warn">desatualizado: a tela não o mostra</Badge>}
              {w.now && <> · <a href={WEATHER_CREDIT_URL} onClick={(e) => { e.preventDefault(); echo.app.openExternal(WEATHER_CREDIT_URL); }}>{WEATHER_CREDIT}</a></>}
            </div>
            {otherPlace && <div className="dv-note warn"><TriangleAlert size={15} /><div>Estes dados são de outro local ({w.place || `${w.lat}, ${w.lon}`}): atualize.</div></div>}
            {w.error && <div className="dv-note warn"><TriangleAlert size={15} /><div>A última atualização falhou: {w.error}</div></div>}
          </div>
        ) : (
          <Empty>Ainda sem dados do clima. Clique em Atualizar agora.</Empty>
        ))}

        <div className="col gap-s">
          <span className="field-label">{hasLocation ? 'Trocar de cidade' : 'Escolher a cidade'}</span>
          <form className="row gap-s" onSubmit={(e) => { e.preventDefault(); search(); }}>
            <input className="input grow" value={query} placeholder="ex.: Campinas, São Paulo" maxLength={80} onChange={(e) => setQuery(e.target.value)} />
            <Button type="submit" icon={<Search size={14} />} busy={busy === 'search'} disabled={!!cityQueryError(query)}>Buscar</Button>
          </form>
          {results && (results.length === 0
            ? <span className="muted small">Nenhuma cidade encontrada com esse nome.</span>
            : (
              <div className="dv-places">
                {results.map((p, i) => (
                  <div key={i} className="dv-place">
                    <div className="grow">
                      <div>{p.label}</div>
                      <div className="muted small mono">{p.lat.toFixed(4)}, {p.lon.toFixed(4)}</div>
                    </div>
                    <Button size="s" variant="primary" busy={busy === 'set'} disabled={busy != null} onClick={() => choose(p)}>Usar</Button>
                  </div>
                ))}
              </div>
            ))}
          <span className="field-hint">O Echo busca a cidade e o clima no Open-Meteo (sem conta nem chave); este app só fala com o Echo. A tela atualiza o clima a cada 30 min e o mostra sob o relógio; a fala depois do alarme também o usa.</span>
        </div>
      </div>
    </Card>
  );
}

const fmtDeg = (n: number | null) => (n == null ? '—' : `${Math.round(n)}°`);
